import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';

vi.mock('@/core/config/env', () => ({ env: { isProd: true } }));

import { REDACT_PATHS } from './logger';

describe('logger redaction', () => {
  it.each(['pan', 'accountNumber', 'secret', 'totpSecret', 'totpSecretEnc', 'recoveryCode', 'recoveryCodes', 'challengeToken'])(
    'covers %s at depth 0, 1 and 2',
    (key) => {
      expect(REDACT_PATHS).toEqual(expect.arrayContaining([key, `*.${key}`, `*.*.${key}`]));
    },
  );

  it('censors 2FA material but keeps other fields', () => {
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
      body: { challengeToken: 'T1', recoveryCodes: ['R1'] },
      a: { b: { recoveryCode: 'R2', totpSecretEnc: 'E1' } },
      keep: 'visible',
    });
    const out = lines.join('');
    for (const leaked of ['S1', 'T1', 'R1', 'R2', 'E1']) expect(out).not.toContain(leaked);
    expect(out).toContain('visible');
    expect(out).toContain('[redacted]');
  });
});
