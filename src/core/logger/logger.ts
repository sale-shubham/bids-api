import pino from 'pino';
import { env } from '@/core/config/env';

const SENSITIVE_KEYS = [
  'pan',
  'accountNumber',
  'secret',
];

// Payout onboarding data (PAN, bank account) must never reach the logs.
export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export const logger = pino({
  level: env.isProd ? 'info' : 'debug',
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
  transport: env.isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});
