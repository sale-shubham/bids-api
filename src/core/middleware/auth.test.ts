import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const SECRET = 'test-access-secret';
const findUnique = vi.fn();

vi.mock('@/core/config/env', () => ({ env: { jwt: { accessSecret: SECRET } } }));
vi.mock('@/core/prisma/client', () => ({ prisma: { session: { findUnique } } }));

const { authenticate, optionalAuthenticate, ACCESS_COOKIE } = await import('./auth');

const token = jwt.sign({ sub: 'm1', role: 'BIDDER', sid: 's1' }, SECRET, { algorithm: 'HS256' });

async function run(mw: typeof authenticate, cookies: Record<string, string>) {
  const req = { headers: {}, cookies } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  await mw(req, {} as Response, next);
  return { req, next: next as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  findUnique.mockReset();
});

describe('authenticate', () => {
  it('rejects a request with no token', async () => {
    const { next } = await run(authenticate, {});
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 401 });
  });

  it('signs in a valid session', async () => {
    findUnique.mockResolvedValue({ memberId: 'm1' });
    const { req, next } = await run(authenticate, { [ACCESS_COOKIE]: token });
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(req.user).toEqual({ sub: 'm1', role: 'BIDDER', sid: 's1' });
  });
});

describe('optionalAuthenticate', () => {
  it('lets an anonymous request through without a user', async () => {
    const { req, next } = await run(optionalAuthenticate, {});
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(req.user).toBeUndefined();
  });

  it('treats a bad token as anonymous, not as a 401', async () => {
    const { req, next } = await run(optionalAuthenticate, { [ACCESS_COOKIE]: 'not-a-jwt' });
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(req.user).toBeUndefined();
  });

  it('treats an evicted session as anonymous', async () => {
    findUnique.mockResolvedValue(null);
    const { req, next } = await run(optionalAuthenticate, { [ACCESS_COOKIE]: token });
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(req.user).toBeUndefined();
  });
});
