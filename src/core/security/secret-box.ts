import crypto from 'node:crypto';
import { env } from '@/core/config/env';
import { AppError } from '@/core/errors/AppError';

// AES-256-GCM envelope for secrets at rest (TOTP seeds). Format: base64(iv[12] | tag[16] | ciphertext).

const IV_LEN = 12;
const TAG_LEN = 16;

export const twoFactorUnavailable = () =>
  new AppError(503, 'TWO_FACTOR_UNAVAILABLE', 'Two-factor authentication is not available right now');

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('TOTP_ENC_KEY must be 32 bytes, base64 encoded');
  return key;
}

/** Key from env, or 503 TWO_FACTOR_UNAVAILABLE when missing / malformed. */
export function envKey(): string {
  const k = env.twoFactor.encKey;
  if (!k) throw twoFactorUnavailable();
  try {
    keyFrom(k);
  } catch {
    throw twoFactorUnavailable();
  }
  return k;
}

export function encryptSecret(plain: string, base64Key = envKey()): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(base64Key), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** Throws on a wrong key or any tampering (GCM auth failure). */
export function decryptSecret(payload: string, base64Key = envKey()): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_LEN + TAG_LEN) throw new Error('Invalid secret payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(base64Key), raw.subarray(0, IV_LEN));
  decipher.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([decipher.update(raw.subarray(IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
}
