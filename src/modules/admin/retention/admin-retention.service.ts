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
// Never below 30 days: shill-bid detection (risk.service.ts) reads Session deviceId / ip from the last 30 days.
export const SESSION_INACTIVE_RETENTION_DAYS = Math.max(30, REFRESH_TTL_MS / 86_400_000);

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
//     API Gateway caps a connection at 2 h, so anything
//     older than that is unambiguously stale. Expired tickets are purged too.
const WS_MAX_CONNECTION_MS = 2 * 60 * 60 * 1000;

export async function purgeStaleWsRows() {
  const ticketCutoff = new Date(Date.now() - 86_400_000);
  const now = new Date();
  // API Gateway hard-caps a connection at 2 h, so older rows are always stale.
  const connectionCutoff = new Date(Date.now() - WS_MAX_CONNECTION_MS);
  const [{ count: ticketsDeleted }, { count: connectionsDeleted }] = await Promise.all([
    prisma.wsTicket.deleteMany({
      where: { OR: [{ createdAt: { lt: ticketCutoff } }, { expiresAt: { lt: now } }] },
    }),
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

// Unique-viewer dedupe rows (AuctionViewer) are only needed for the day they were written; keep 30 days.
export const AUCTION_VIEWER_RETENTION_DAYS = 30;

export async function purgeAuctionViewers(retentionDays = AUCTION_VIEWER_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const { count } = await prisma.auctionViewer.deleteMany({ where: { date: { lt: cutoff } } });
  return count;
}

export async function runRetentionPurge(overrides?: { otpChallengeDays?: number; sessionInactiveDays?: number }) {
  const [otpChallengesDeleted, sessionsDeleted, wsRowsDeleted, rateLimitBucketsDeleted, auctionViewersDeleted] = await Promise.all([
    purgeExpiredOtpChallenges(overrides?.otpChallengeDays),
    purgeStaleSessions(overrides?.sessionInactiveDays),
    purgeStaleWsRows(),
    purgeExpiredRateLimitBuckets(),
    purgeAuctionViewers(),
  ]);

  logger.info(
    { otpChallengesDeleted, sessionsDeleted, ...wsRowsDeleted, rateLimitBucketsDeleted, auctionViewersDeleted },
    'Retention purge complete',
  );
  return { otpChallengesDeleted, sessionsDeleted, ...wsRowsDeleted, rateLimitBucketsDeleted, auctionViewersDeleted };
}
