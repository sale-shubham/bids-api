import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { PgRateLimitStore } from '@/core/middleware/pgRateLimitStore';
import { env } from '@/core/config/env';
import { verifyTwoFactorChallenge } from '@/modules/auth/token.service';

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
// Lower-cased + trimmed email from the body (same normalisation as the
// validation layer), so case variants can't dodge a per-email limit.
const bodyEmail = (req: { body?: { email?: unknown } }) => String(req.body?.email ?? '').trim().toLowerCase();

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
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}:${bodyEmail(req)}`,
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

// Login brute-force guard, per email (all IPs). Stacked with authLimiter (per IP).
export const loginEmailLimiter = rateLimit({
  store: new PgRateLimitStore('rl:login-email:'),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => bodyEmail(req) || 'none',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many login attempts, try later' } },
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

// Light per-member cap on auction create / patch / republish (authenticated,
// so keyed by member id). In-memory like apiLimiter — a spam guard, not money.
export const auctionWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, try later' } },
});

// Bulk auction create: 5 batches per hour per member (authenticated, so keyed by member id).
export const bulkLimiter = rateLimit({
  store: new PgRateLimitStore('rl:bulk:'),
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many bulk uploads, try again later' } },
});

// Bidding (money-adjacent, authenticated). Two stacked caps, both keyed by the
// member and shared across Lambda containers via the Pg store: ~10 bids per
// 10 s per member per auction (stops a script hammering one auction), and 60
// per minute per member overall. Mounted after authenticate, so req.user is set.
export const bidAuctionLimiter = rateLimit({
  store: new PgRateLimitStore('rl:bid-auction:'),
  passOnStoreError: true,
  windowMs: 10 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown')}:${typeof req.params?.id === 'string' ? req.params.id : ''}`,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'You are bidding too fast, slow down' } },
});

export const bidMemberLimiter = rateLimit({
  store: new PgRateLimitStore('rl:bid-member:'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many bids, try again shortly' } },
});

// Public guest WebSocket tickets: per-IP, 30/min (a reconnect loop must not
// be able to mint unlimited rows).
export const wsGuestLimiter = rateLimit({
  store: new PgRateLimitStore('rl:ws-guest:'),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, try later' } },
});

// Public contact form: 5 messages per hour per IP (each one sends an email).
export const contactLimiter = rateLimit({
  store: new PgRateLimitStore('rl:contact:'),
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many messages, try again later' } },
});

// Lot Q&A: 10 questions per hour per member (authenticated, so keyed by member id).
export const qaLimiter = rateLimit({
  store: new PgRateLimitStore('rl:qa:'),
  passOnStoreError: true,
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many questions, try again later' } },
});

// 2FA login step: 5 attempts / 10 min per member, keyed by the (verified) challenge token subject so a
// guesser cannot rotate IPs; a bad token falls back to the IP.
export const twoFactorLimiter = rateLimit({
  store: new PgRateLimitStore('rl:2fa:'),
  passOnStoreError: true,
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    try {
      return verifyTwoFactorChallenge(String(req.body?.challengeToken ?? '')).sub;
    } catch {
      return ipKeyGenerator(req.ip ?? 'unknown');
    }
  },
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, try again later' } },
});

// Reports: 20 per day per member (authenticated, so keyed by member id).
export const reportLimiter = rateLimit({
  store: new PgRateLimitStore('rl:report:'),
  passOnStoreError: true,
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? ipKeyGenerator(req.ip ?? 'unknown'),
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many reports today, try again tomorrow' } },
});
