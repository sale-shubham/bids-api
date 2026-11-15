import pino from 'pino';
import { env } from '@/core/config/env';

export const logger = pino({
  level: env.isProd ? 'info' : 'debug',
  // Payout onboarding data (PAN, bank account) must never reach the logs.
  redact: {
    paths: ['pan', 'accountNumber', '*.pan', '*.accountNumber', '*.*.pan', '*.*.accountNumber'],
    censor: '[redacted]',
  },
  transport: env.isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});
