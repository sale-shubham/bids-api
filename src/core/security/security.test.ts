import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

const envMock = vi.hoisted(() => ({ twoFactor: { encKey: '' } }));
vi.mock('@/core/config/env', () => ({ env: envMock }));

import { base32Decode, base32Encode, generateTotpSecret, otpauthUrl, totpAt, verifyTotp } from './totp';
import { decryptSecret, encryptSecret } from './secret-box';

// RFC 6238 appendix B (SHA-1, ASCII secret "12345678901234567890"), last 6 digits of the 8-digit values.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('base32', () => {
  it('round trips and matches RFC 4648 vectors', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw 6ytb-oi==').toString()).toBe('foobar');
    const raw = crypto.randomBytes(20);
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
  });
  it('rejects invalid characters', () => {
    expect(() => base32Decode('abc1')).toThrow();
  });
});

describe('totp', () => {
  it.each(VECTORS)('RFC 6238 vector at t=%i', (t, code) => {
    expect(totpAt(RFC_SECRET, t * 1000)).toBe(code);
  });
  it('accepts +-1 step and rejects +-2 steps', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now - 30_000)).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, now + 90_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, code, now - 90_000)).toBe(false);
  });
  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345', 0)).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdef', 0)).toBe(false);
  });
  it('generates a 32-char secret and an otpauth url', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl(s, 'a@x.test')).toBe(`otpauth://totp/NobleBid:a%40x.test?secret=${s}&issuer=NobleBid`);
  });
});

describe('secret-box', () => {
  const key = crypto.randomBytes(32).toString('base64');
  it('round trips with a random iv', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const b = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('detects tampering and a wrong key', () => {
    const enc = Buffer.from(encryptSecret('secret', key), 'base64');
    enc[enc.length - 1] ^= 1;
    expect(() => decryptSecret(enc.toString('base64'), key)).toThrow();
    const good = encryptSecret('secret', key);
    expect(() => decryptSecret(good, crypto.randomBytes(32).toString('base64'))).toThrow();
    expect(() => decryptSecret('AAAA', key)).toThrow();
  });
  it('503 TWO_FACTOR_UNAVAILABLE when the env key is missing', () => {
    envMock.twoFactor.encKey = '';
    expect(() => encryptSecret('x')).toThrowError(expect.objectContaining({ statusCode: 503, code: 'TWO_FACTOR_UNAVAILABLE' }));
  });
});
