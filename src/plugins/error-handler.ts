import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      req.log.warn({ code: error.code }, error.message);
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }
    req.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });
}
