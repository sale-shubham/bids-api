import express from 'express';
import { describe, expect, it } from 'vitest';
import { BadRequest } from '@/core/errors/AppError';
import { errorHandler } from './errorHandler';

// Real express.json() in front of the real handler, so the test covers the
// error objects body-parser actually throws, not hand-made look-alikes.
async function post(body: string, contentType = 'application/json') {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/x', (req, res) => res.json({ got: req.body }));
  app.post('/app-error', () => {
    throw BadRequest('nope');
  });
  app.post('/boom', () => {
    throw new Error('secret internals');
  });
  app.use(errorHandler);
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  try {
    const path = body === '__app_error__' ? '/app-error' : body === '__boom__' ? '/boom' : '/x';
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: body.startsWith('__') ? '{}' : body,
    });
    return { status: res.status, body: (await res.json()) as { error?: { code: string; message: string } } };
  } finally {
    server.close();
  }
}

describe('errorHandler', () => {
  it('returns 400 INVALID_JSON for a malformed JSON body', async () => {
    const res = await post('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'INVALID_JSON', message: 'Request body is not valid JSON' });
  });

  it('returns 413 PAYLOAD_TOO_LARGE for a body over the limit', async () => {
    const res = await post(JSON.stringify({ s: 'x'.repeat(2048) }));
    expect(res.status).toBe(413);
    expect(res.body.error?.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('still parses a valid body', async () => {
    expect(await post('{"a":1}')).toEqual({ status: 200, body: { got: { a: 1 } } });
  });

  it('keeps AppError handling', async () => {
    const res = await post('__app_error__');
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe('nope');
  });

  it('keeps unknown errors as a generic 500', async () => {
    const res = await post('__boom__');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  });
});
