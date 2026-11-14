import express from 'express';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/core/errors/AppError';
import { param } from './params';

// Drives a real Express 5 router so the test covers how v5 actually fills
// req.params, not just the helper in isolation.
async function call(path: string, route: string, name: string) {
  const app = express();
  app.get(route, (req, res) => {
    try {
      res.json({ value: param(req, name) });
    } catch (err) {
      res.status(err instanceof AppError ? err.statusCode : 500).json({ error: (err as Error).message });
    }
  });
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe('param()', () => {
  it('returns a named param as a string', async () => {
    expect(await call('/companies/c_123/payments', '/companies/:companyId/payments', 'companyId')).toEqual({
      status: 200,
      body: { value: 'c_123' },
    });
  });

  it('decodes percent-encoded values like Express 4 did', async () => {
    expect((await call('/items/a%20b', '/items/:id', 'id')).body).toEqual({ value: 'a b' });
  });

  it('rejects an array-valued (wildcard) param with 400', async () => {
    const res = await call('/files/a/b', '/files/*rest', 'rest');
    expect(res.status).toBe(400);
  });

  it('rejects a param the route does not define with 400', async () => {
    expect((await call('/items/1', '/items/:id', 'missing')).status).toBe(400);
  });
});
