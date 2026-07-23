import pino from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL || 'info',
  // Redact anything that could leak a secret from logs.
  redact: {
    paths: ['req.headers.authorization', '*.password', '*.passwordHash', '*.secret', '*.token'],
    censor: '[REDACTED]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
