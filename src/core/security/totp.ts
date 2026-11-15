import crypto from 'node:crypto';

// RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits) with RFC 4648 base32, on node crypto only.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/[\s-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 20 random bytes (RFC 4226 recommended length), base32 encoded. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totpAt(base32Secret: string, timeMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(base32Secret), Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS), digits);
}

/** Accepts the current step and `window` steps either side (default +-1). */
export function verifyTotp(base32Secret: string, code: string, timeMs = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(base32Secret);
  const step = Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    const expected = Buffer.from(hotp(secret, step + i));
    // No early exit: constant work whatever the match.
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) ok = true;
  }
  return ok;
}

export function otpauthUrl(secret: string, accountEmail: string, issuer = 'NobleBid'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
