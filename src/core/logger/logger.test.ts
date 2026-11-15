import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

vi.mock('@/core/config/env', () => ({ env: { isProd: true } }));

import { REDACT_PATHS } from './logger';

describe('logger redaction', () => {
  it.each(['pan', 'accountNumber', 'secret'])(
    'covers %s at depth 0, 1 and 2',
    (key) => {
      expect(REDACT_PATHS).toEqual(expect.arrayContaining([key, `*.${key}`, `*.*.${key}`]));
    },
  );

  it('censors sensitive keys but keeps other fields', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const l = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, stream);
    l.info({
      secret: 'S1',
      body: { pan: 'P1', accountNumber: ['A1'] },
      a: { b: { secret: 'S2' } },
      keep: 'visible',
    });
    const out = lines.join('');
    for (const leaked of ['S1', 'P1', 'A1', 'S2']) expect(out).not.toContain(leaked);
    expect(out).toContain('visible');
    expect(out).toContain('[redacted]');
  });
});
