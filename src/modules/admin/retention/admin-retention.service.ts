import { prisma } from '@/core/prisma/client';
import { REFRESH_TTL_MS } from '@/modules/auth/token.service';
import { logger } from '@/core/logger/logger';

/**
 * Retention purge — erase data once its purpose is served. Scoped to two
 * tables whose rows are objectively stale:
 *   - OtpChallenge past its expiry + a grace window.
 *   - Session unused past the inactivity window (a stale device login).
 * Plus operational cleanup of WebSocket rows and rate-limit buckets below.
 *
 * Fixed constants, not env-configurable — a retention window isn't a
 * per-deploy tuning knob.
 */
export const OTP_CHALLENGE_RETENTION_DAYS = 30;
// Matches REFRESH_TTL_MS (token.service.ts): the refresh token itself is
// dead by 30 days, so a Session row that's been idle that long has already
// stopped granting access — keeping it around longer has no purpose left.
export const SESSION_INACTIVE_RETENTION_DAYS = REFRESH_TTL_MS / 86_400_000;

export async function purgeExpiredOtpChallenges(retentionDays = OTP_CHALLENGE_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.otpChallenge.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return count;
}

export async function purgeStaleSessions(retentionDays = SESSION_INACTIVE_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.session.deleteMany({ where: { lastUsedAt: { lt: cutoff } } });
  return count;
}

// Not a DPDP purge like the two above — plain operational cleanup for the
// WebSocket feature . Lives in the same daily job
// purely for convenience (one sweep, not a new cron).
//   - WsTicket: every ticket is single-use and only ever valid for ~60s
//     (WS_TICKET_TTL_MS, ws.service.ts) — anything past a day old is either
//     already consumed or long expired, either way garbage.
//   - WsConnection: normally deleted by $disconnect, or lazily by
//     pushToMember on a GoneException. This is the safety net for a
//     connection that dropped without either ever firing (network cut, tab
//     killed) and was never pushed to again to trigger the lazy cleanup —
//     24h is far longer than any real session, so anything that old is
//     unambiguously stale.
export async function purgeStaleWsRows() {
  const ticketCutoff = new Date(Date.now() - 86_400_000);
  const connectionCutoff = new Date(Date.now() - 86_400_000);
  const [{ count: ticketsDeleted }, { count: connectionsDeleted }] = await Promise.all([
    prisma.wsTicket.deleteMany({ where: { createdAt: { lt: ticketCutoff } } }),
    prisma.wsConnection.deleteMany({ where: { connectedAt: { lt: connectionCutoff } } }),
  ]);
  return { ticketsDeleted, connectionsDeleted };
}

// Operational cleanup too: RateLimitBucket rows (pgRateLimitStore.ts) whose
// window ended. An expired row is already ignored — the next hit restarts it
// at 1 — so this only stops one-off keys (every IP/identifier ever seen) from
// accumulating. The longest limiter window is 1h; a day of slack is plenty.
export async function purgeExpiredRateLimitBuckets() {
  const cutoff = new Date(Date.now() - 86_400_000);
  const { count } = await prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: cutoff } } });
  return count;
}

export async function runRetentionPurge(overrides?: { otpChallengeDays?: number; sessionInactiveDays?: number }) {
  const [otpChallengesDeleted, sessionsDeleted, wsRowsDeleted, rateLimitBucketsDeleted] = await Promise.all([
    purgeExpiredOtpChallenges(overrides?.otpChallengeDays),
    purgeStaleSessions(overrides?.sessionInactiveDays),
    purgeStaleWsRows(),
    purgeExpiredRateLimitBuckets(),
  ]);

  logger.info(
    { otpChallengesDeleted, sessionsDeleted, ...wsRowsDeleted, rateLimitBucketsDeleted },
    'Retention purge complete',
  );
  return { otpChallengesDeleted, sessionsDeleted, ...wsRowsDeleted, rateLimitBucketsDeleted };
}
