import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';
import { sendAlert, describeFault } from '../lib/alerts.js';
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

    /*
     * Errors Fastify raises itself, reported as what they are.
     *
     * These carry their own `statusCode` and it was being thrown away, so every one came
     * back to the client as 500 INTERNAL. A malformed request the caller could fix read as
     * a server fault, and the client had nothing useful to show: publishing a legal
     * document failed with "Could not publish (500)" when the real answer was 415, the
     * request never reached the route, and nothing was wrong with the server at all.
     *
     * Worse, they fell through to `sendAlert` below. A 415, a 400 on malformed JSON, a 413
     * on an oversized upload — all caller-side, none a fault worth waking anyone for, and
     * every one of them has been sending alert emails. Deduplication kept the volume down,
     * which is precisely why it went unnoticed.
     *
     * Restricted to 4xx. A 5xx from Fastify is a genuine fault and must keep falling
     * through to the alert below.
     *
     * Read through one narrowed view rather than casting at each use. `error` is
     * `unknown` here — which is why every branch above reaches `.message` only after an
     * `instanceof` check. Each field is checked for the type it is used as, so a thrown
     * object with a numeric `code`, or a `message` that is not a string, cannot put a
     * number or an object into a JSON error response.
     */
    const shape = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const fastifyStatus = typeof shape.statusCode === 'number' ? shape.statusCode : 0;
    if (fastifyStatus >= 400 && fastifyStatus < 500) {
      const code = typeof shape.code === 'string' ? shape.code : 'BAD_REQUEST';
      const message = typeof shape.message === 'string' ? shape.message : 'Bad request';
      req.log.warn({ code, statusCode: fastifyStatus }, message);
      return reply.status(fastifyStatus).send({ error: code, message });
    }

    req.log.error({ err: error }, 'unhandled error');

    // Anything reaching here is a genuine fault rather than a handled state, so it
    // is worth waking someone. Fire-and-forget and deduplicated by fingerprint — a
    // route broken for every request sends one email an hour, not one per request.
    const { title, detail } = describeFault(error);
    sendAlert({
      title,
      detail,
      err: error,
      route: req.routeOptions?.url ?? req.url,
      method: req.method,
      context: { reqId: req.id },
    });

    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });
}
