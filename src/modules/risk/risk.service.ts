import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { DAY_MS, RISK_THRESHOLD, SESSION_WINDOW_DAYS, mergeSignal, scoreBidRisk, type Scored } from './risk.rules';

/** Create or update the (auction, bidder) signal (max score, merged reasons) and tell every SUPER_ADMIN. Never throws. */
export async function upsertSignal(input: { auctionId: string; bidderId: string; sellerId: string } & Scored): Promise<boolean> {
  try {
    if (input.score < RISK_THRESHOLD) return false;
    const key = { auctionId_bidderId: { auctionId: input.auctionId, bidderId: input.bidderId } };
    const existing = await prisma.shillSignal.findUnique({ where: key, select: { score: true, reasons: true } });
    const merged = mergeSignal(existing ?? null, input);
    await prisma.shillSignal.upsert({
      where: key,
      create: { auctionId: input.auctionId, bidderId: input.bidderId, sellerId: input.sellerId, score: merged.score, reasons: merged.reasons },
      update: { score: merged.score, reasons: merged.reasons },
    });
    const admins = await prisma.member.findMany({ where: { role: 'SUPER_ADMIN', isActive: true }, select: { id: true } });
    for (const a of admins) {
      await enqueueNotification({
        type: 'shill-flag',
        memberId: a.id,
        auctionId: input.auctionId,
        data: { bidderId: input.bidderId, sellerId: input.sellerId, score: merged.score, reasons: merged.reasons },
        dedupeKey: `shill-flag:${input.auctionId}:${input.bidderId}:${a.id}`,
      });
    }
    return true;
  } catch (err) {
    logger.error({ err, auctionId: input.auctionId, bidderId: input.bidderId }, 'risk: could not store the signal');
    return false;
  }
}

/**
 * After a bid committed: compare the bidder's recent sessions (last 30 days by lastUsedAt) with the seller's, and
 * check whether the bidder is a new account that only bids on this seller. Flags at score >= 50. Best effort:
 * callers wrap it, it never blocks or fails the bid.
 */
export async function checkBidRisk(input: { auctionId: string; bidderId: string; sellerId: string }, now = new Date()) {
  const { auctionId, bidderId, sellerId } = input;
  const since = new Date(now.getTime() - SESSION_WINDOW_DAYS * DAY_MS);
  const sessionWhere = (memberId: string) => ({ memberId, lastUsedAt: { gte: since } });
  const select = { deviceId: true, ip: true } as const;
  const [bidderSessions, sellerSessions, bidder, bidsTotal, bidsOnSeller] = await Promise.all([
    prisma.session.findMany({ where: sessionWhere(bidderId), select }),
    prisma.session.findMany({ where: sessionWhere(sellerId), select }),
    prisma.member.findUnique({ where: { id: bidderId }, select: { createdAt: true } }),
    prisma.bid.count({ where: { bidderId } }),
    prisma.bid.count({ where: { bidderId, auction: { sellerId } } }),
  ]);
  const sellerDevices = new Set((sellerSessions ?? []).map((s) => s.deviceId));
  const sellerIps = new Set((sellerSessions ?? []).flatMap((s) => (s.ip ? [s.ip] : [])));
  const scored = scoreBidRisk({
    sharedDevice: (bidderSessions ?? []).some((s) => sellerDevices.has(s.deviceId)),
    sharedIp: (bidderSessions ?? []).some((s) => !!s.ip && sellerIps.has(s.ip)),
    accountAgeMs: bidder ? now.getTime() - bidder.createdAt.getTime() : Number.MAX_SAFE_INTEGER,
    bidsTotal: bidsTotal ?? 0,
    bidsOnSeller: bidsOnSeller ?? 0,
  });
  const flagged = await upsertSignal({ auctionId, bidderId, sellerId, ...scored });
  return { ...scored, flagged };
}
