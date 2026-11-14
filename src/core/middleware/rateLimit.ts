import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { PgRateLimitStore } from '@/core/middleware/pgRateLimitStore';
import { env } from '@/core/config/env';

// Custom keyGenerators key the client IP through the library's
// `ipKeyGenerator`, never raw `req.ip`: it groups an IPv6 client by /56
// subnet (a single host is routinely handed a /64 or wider and can rotate
// through billions of source addresses, so keying the full address lets one
// client walk straight past every limit below) and unwraps IPv4-mapped
// addresses to their IPv4 form. It must be called inline in each
// keyGenerator — express-rate-limit v8 scans the keyGenerator's source at
// startup and logs ERR_ERL_KEY_GEN_IPV6 when it sees `req.ip` without it.
// A missing `req.ip` keys as 'unknown'.

// Store choice. The money/security-bearing limiters (auth, OTP, sensitive) use PgRateLimitStore, so the count is shared by every Lambda
// container — the in-memory default counts per container, and a client spread
// over several warm containers would get the limit times that many. A DB error
// fails open (passOnStoreError) rather than 500ing a login. apiLimiter is a
// cheap anti-hammering guard on ordinary writes and stays in-memory.
export const authLimiter = rateLimit({
  store: new PgRateLimitStore('rl:auth:'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: env.rateLimit.authMax, // 20 unless RATE_LIMIT_AUTH_MAX (dev only)
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, try later' } },
});

// Email-cost-bearing — tighter than authLimiter, keyed by identifier+IP so
// one email can't be spammed from many IPs (or vice versa).
export const otpLimiter = rateLimit({
  store: new PgRateLimitStore('rl:otp:'),
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}:${req.body?.email ?? ''}`,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many OTP requests, try later' } },
});

// Per-IP cap across ALL identifiers. otpLimiter is keyed by IP+identifier, so
// on its own one IP could send OTPs to an unlimited number of different
// emails (OTP pumping, each send billed). Stacked in front of
// otpLimiter on every route that sends an OTP.
export const otpIpLimiter = rateLimit({
  store: new PgRateLimitStore('rl:otp-ip:'),
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000,
  max: env.rateLimit.otpIpMax, // 20 unless RATE_LIMIT_OTP_IP_MAX (dev only)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many OTP requests, try later' } },
});

export const sensitiveLimiter = rateLimit({
  store: new PgRateLimitStore('rl:sensitive:'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, try later' } },
});

// General-purpose per-member (falling back to per-IP) limiter for ordinary
// authenticated write endpoints that aren't costly/security-sensitive enough
// for sensitiveLimiter (e.g. placing a bid) but still shouldn't be
// hammered unbounded.
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, try later' } },
});
