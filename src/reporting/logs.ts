import pino from 'pino';

const ALLOWED_LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);
const rawLevel = process.env.LOG_LEVEL ?? 'info';
const level = ALLOWED_LOG_LEVELS.has(rawLevel) ? rawLevel : 'info';

const transport = pino.transport({
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'SYS:standard' },
});

export const logger = pino({
  level,
  redact: {
    paths: [
      'authorization',
      'Authorization',
      '*.authorization',
      '*.Authorization',
      'apiKey',
      '*.apiKey',
      'token',
      '*.token',
      'secret',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
}, transport);
