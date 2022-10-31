import Logger, { LogLevel } from 'bunyan'
import PrettyStream from 'bunyan-prettystream'
import {
  HttpRequest,
  middleware as commonMiddleware,
} from '@google-cloud/logging'
import {
  LoggingBunyan,
  LOGGING_SAMPLED_KEY,
  LOGGING_SPAN_KEY,
  LOGGING_TRACE_KEY,
} from '@google-cloud/logging-bunyan'
import { ServerResponse } from 'http'
import { ServerRequest } from '@google-cloud/logging/build/src/utils/http-request'
import fastRedact from 'fast-redact'

// GAE_SERVICE is the service name of the App Engine service:
//   https://cloud.google.com/appengine/docs/standard/nodejs/runtime#environment_variables
// We also use it to infer we're running in an App Engine environment.
// K_SERVICE name of function resource on a Cloud Function:
//   https://cloud.google.com/functions/docs/configuring/env-var#newer_runtimes
// We also use it to infer we're running in a Cloud Function environment.
function getGoogleServiceName() {
  return process.env.GAE_SERVICE || process.env.K_SERVICE
}

interface ExtendedRedactOptions extends fastRedact.RedactOptions {
  // Allows to globally replace sensitive patterns
  // WARNING: the value is JSON.stringified before being passed to this function
  // and will be JSON.parse'd after
  globalReplace?: (value: string) => string
}

export function createLogger({
  level,
  redact: redactConfig,
}: {
  level?: LogLevel
  redact?: ExtendedRedactOptions
} = {}) {
  const logLevel = level || (process.env.LOG_LEVEL as LogLevel) || 'info'
  const streams: Logger.Stream[] = []
  let name = 'default'

  const googleServiceName = getGoogleServiceName()

  if (googleServiceName) {
    // https://github.com/googleapis/nodejs-logging-bunyan/issues/304
    // https://github.com/googleapis/nodejs-logging-bunyan#alternative-way-to-ingest-logs-in-google-cloud-managed-environments
    // redirectToStdout helps ensure the logging stream is flushed before the process exists.
    // useMessageField must be `false` for Logs Explorer to show the string message as a log entry line
    // Otherwise it nests everything under `jsonPayload.message` and all lines in Logs Explorer look like JSON noise.
    const loggingBunyan = new LoggingBunyan({
      redirectToStdout: true,
      useMessageField: false,
    })
    name = googleServiceName
    streams.push(loggingBunyan.stream(logLevel))
  } else {
    const consoleStream = new PrettyStream({ mode: 'short' })
    consoleStream.pipe(process.stdout)
    streams.push({ stream: consoleStream, level: logLevel })
  }

  const logger = Logger.createLogger({
    name,
    streams,
    serializers: createDetailedRequestSerializers(),
  })

  const redact = fastRedact({ ...redactConfig, serialize: false })

  // Patch _emit to redact sensitive data
  // This redacts **all** fields in the log record, not just the ones we specify in the serializers
  // @ts-expect-error
  logger._emit = new Proxy(logger._emit, {
    apply: function (target, thisArgument, argumentsList) {
      const [logRecord] = argumentsList

      const globalReplace =
        redactConfig?.globalReplace ?? ((value: string) => value)

      // Preserve bunyan's core fields (except for msg)
      // See https://github.com/trentm/node-bunyan#core-fields
      const { v, level, name, hostname, pid, time, src, ...rest } = logRecord

      // redact mutates the input object,
      // so here we copy it and overwrite the log record with the redacted copied version
      // This makes the redact action stable when calling `logger.info({ req })` multiple times
      // i.e. the original `req` object is not mutated
      // This assumes all fields are serializable, which they should at this point
      Object.assign(
        logRecord,
        redact(JSON.parse(globalReplace(JSON.stringify(rest)))),
      )

      // Call the original _emit
      return Reflect.apply(target, thisArgument, argumentsList)
    },
  })

  return logger
}

// Adapted from https://github.com/googleapis/nodejs-logging-bunyan/blob/4de2b3dd9e8f6b336d9ca3609f775046a6f74424/src/middleware/express.ts
// This logs the request and response objects for all requests.
// It also shows nicely formatted request logs for Cloud Functions in Logs Explorer (App Engine does this automatically).
export function createLoggingMiddleware({
  projectId,
  logger,
}: {
  projectId: string
  logger: Logger
}) {
  function makeChildLogger(trace: string, span?: string) {
    return logger.child(
      { [LOGGING_TRACE_KEY]: trace, [LOGGING_SPAN_KEY]: span },
      true /* simple child */,
    )
  }

  return (req: ServerRequest, res: ServerResponse, next: Function) => {
    const emitRequestLog = (
      httpRequest: HttpRequest,
      trace: string,
      span?: string,
      sampled?: boolean,
    ) => {
      const { requestUrl } = httpRequest
      const cloudFunctionName = process.env.K_SERVICE
      logger.info(
        {
          // Log more info about the request
          // See also the serializers for these fields
          req,
          res,
          // Note: Contrary to what the documentation says for `makeMiddleware`,
          // Cloud Functions (at least the gen1 version we use) doesn't already log the httpRequest
          // So we do it ourselves
          ...(cloudFunctionName
            ? {
                // This shows the nicely formatted request log in Logs Explorer.
                // See https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#HttpRequest
                httpRequest: {
                  ...httpRequest,
                  // Add the Cloud Function name to the path so it's easier to see which function was called in Logs Explorer
                  // By default it only shows `/?${query}` and hides the function name (and execution id) pills
                  // from the summary line which are otherwise present when httpRequest is not set
                  requestUrl:
                    requestUrl?.startsWith('/') &&
                    !requestUrl.startsWith(`/${cloudFunctionName}`)
                      ? `/${cloudFunctionName}${requestUrl}`
                      : requestUrl,
                },
                [LOGGING_TRACE_KEY]: trace,
                [LOGGING_SPAN_KEY]: span,
                [LOGGING_SAMPLED_KEY]: sampled,
              }
            : undefined),
        },
        'Request finished',
      )
    }
    commonMiddleware.express.makeMiddleware(
      projectId,
      makeChildLogger,
      emitRequestLog,
    )(req, res, next)
  }
}

// Similar to the stdSerializers in bunyan, but with a few extra fields (query and body mostly)
export function createDetailedRequestSerializers() {
  const serializers: Logger.Serializers = { err: Logger.stdSerializers.err }

  serializers.req = (req: any) => {
    if (!req || !req.connection) {
      return req
    }
    return {
      method: req.method,
      // Accept `req.originalUrl` for expressjs usage.
      // https://expressjs.com/en/api.html#req.originalUrl
      url: req.originalUrl || req.url,
      query: req.query,
      body: req.body,
      headers: req.headers,
      remoteAddress: req.connection.remoteAddress,
      remotePort: req.connection.remotePort,
    }
  }

  serializers.res = (res: any) => {
    if (!res || !res.statusCode) {
      return res
    }
    return {
      statusCode: res.statusCode,
      header: res._header,
    }
  }

  return serializers
}
