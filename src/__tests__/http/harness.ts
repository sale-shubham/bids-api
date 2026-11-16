// Shared harness for the HTTP tests (supertest against createApp()).
//
// Import this module FIRST in every *.http.test.ts: it pins the env vars that
// src/core/config/env.ts reads at import time. Everything external is mocked
// by the test files via vi.mock (prisma, rate-limit store, logger, providers).
import { vi, type Mock } from 'vitest';
import type { Express } from 'express';

export const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  JWT_SECRET: 'http-test-access-secret',
  REFRESH_TOKEN_SECRET: 'http-test-refresh-secret',
  CORS_ORIGINS: 'http://localhost:3000,https://app.noblebid.test',
  COOKIE_DOMAIN: '', // empty = host-only cookies
  COOKIE_SAMESITE: '',
  PAYMENT_DRIVER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_http_test',
  EMAIL_DRIVER: 'stub',
  OTP_DRIVER: 'stub',
  ADMIN_EMAIL: 'admin@noblebid.test',
  AWS_CLOUDFRONT_URL: 'https://cdn.noblebid.test',
  AWS_BUCKET_NAME: 'nb-test-bucket',
  NOTIFY_QUEUE_URL: '',
  WS_API_ENDPOINT: '',
} as const;

// Direct assignment (not vi.stubEnv): env.ts is evaluated once per test file
// and vitest isolates each file in its own worker.
for (const [k, v] of Object.entries(TEST_ENV)) process.env[k] = v;

// ------------------------------------------------------------------ prisma

type AnyFn = Mock<(...args: any[]) => any>;
const registry = new Map<string, AnyFn>();
const fnFor = (path: string): AnyFn => {
  let fn = registry.get(path);
  if (!fn) {
    fn = vi.fn() as AnyFn;
    registry.set(path, fn);
  }
  return fn;
};

/**
 * Deep-proxy prisma double: `prisma.<model>.<method>` is a cached vi.fn()
 * (undefined result by default), so a test only configures what its request
 * touches, e.g. `prismaMock.auction.findUnique.mockResolvedValue(null)`.
 */
export const prismaMock: any = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop.startsWith('$')) return fnFor(prop);
      return new Proxy(
        {},
        {
          get(_m, method) {
            if (typeof method !== 'string' || method === 'then') return undefined;
            return fnFor(`${prop}.${method}`);
          },
        },
      );
    },
  },
);

/** Reset every prisma fn and re-install the defaults the auth guards need. */
export function resetPrismaMock() {
  for (const fn of registry.values()) fn.mockReset();
  // Session ids are `s-<memberId>` (see bearer()).
  fnFor('session.findUnique').mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    memberId: where.id.replace(/^s-/, ''),
  }));
  fnFor('member.findUnique').mockResolvedValue({ id: 'm1', name: 'Test Member', isActive: true });
  // Interactive transactions run against the same double; array form resolves each promise.
  fnFor('$transaction').mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prismaMock) : Promise.all(arg as unknown[]),
  );
}

// ------------------------------------------------------------------ other doubles

/** Replacement for PgRateLimitStore: never limits, never touches the DB. */
export class PassStore {
  localKeys = false;
  constructor(public prefix: string) {}
  init() {}
  async increment() {
    return { totalHits: 1, resetTime: new Date(Date.now() + 60_000) };
  }
  async decrement() {}
  async resetKey() {}
}

const noop = () => {};
export const silentLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  fatal: noop,
  trace: noop,
  child: () => silentLogger,
};

// ------------------------------------------------------------------ app + tokens

let app: Express | undefined;
export async function getApp(): Promise<Express> {
  if (!app) app = (await import('@/app')).createApp();
  return app;
}

type Role = 'MEMBER' | 'SUPER_ADMIN';

/** A real access token (real token service + test secret) for member `id`. */
export async function tokenFor(role: Role, id = 'm1'): Promise<string> {
  const { signAccessToken } = await import('@/modules/auth/token.service');
  return signAccessToken({ id, role }, `s-${id}`);
}

/** `Authorization` header value for a member of `role`. */
export async function bearer(role: Role, id = 'm1'): Promise<string> {
  return `Bearer ${await tokenFor(role, id)}`;
}
