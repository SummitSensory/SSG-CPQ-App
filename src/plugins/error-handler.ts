import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
import { QboApiError, QboAuthError } from '../integrations/quickbooks/http.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      req.log.warn({ code: error.code }, error.message);
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }

    // A dead QuickBooks authorization is a state the operator can fix, not a
    // server fault. It gets its own code so the client can say "reconnect"
    // rather than showing a generic failure the user can do nothing about.
    if (error instanceof QboAuthError) {
      req.log.warn({ intuitTid: error.intuitTid }, error.message);
      return reply.status(409).send({
        error: 'QBO_RECONNECT_REQUIRED',
        message: error.message,
        requiresReconnect: true,
        intuitTid: error.intuitTid,
      });
    }

    // Surface Intuit's own fault code and correlation id. Without the tid there
    // is no way to ask Intuit support what happened to a specific call.
    if (error instanceof QboApiError) {
      req.log.error(
        { status: error.status, intuitTid: error.intuitTid, faultCode: error.faultCode },
        error.message,
      );
      return reply.status(502).send({
        error: 'QBO_REQUEST_FAILED',
        message: error.message,
        faultCode: error.faultCode,
        intuitTid: error.intuitTid,
      });
    }

    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });
}
