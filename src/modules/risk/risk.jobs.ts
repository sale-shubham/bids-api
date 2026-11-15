import { prisma } from '@/core/prisma/client';
import { logger } from '@/core/logger/logger';
import { DAY_MS, SCAN_WINDOW_DAYS, scanBids, type ScanBid } from './risk.rules';
import { upsertSignal } from './risk.service';

const MAX_ROWS = 100_000;

export type RiskScanCounts = { scanned: number; flagged: number };

/** Daily: scan the last 90 days of bids for concentration / never-wins patterns and upsert signals. Idempotent. */
export async function runRiskScan(now = new Date()): Promise<RiskScanCounts> {
  const since = new Date(now.getTime() - SCAN_WINDOW_DAYS * DAY_MS);
  const rows = await prisma.bid.findMany({
    where: { createdAt: { gte: since } },
    select: { bidderId: true, auctionId: true, auction: { select: { sellerId: true, status: true, winnerId: true, endTime: true } } },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
  });
  if (rows.length === MAX_ROWS) logger.warn({ rows: rows.length }, 'risk scan: bid window truncated');

  const bids: ScanBid[] = rows.map((r) => ({
    bidderId: r.bidderId,
    auctionId: r.auctionId,
    sellerId: r.auction.sellerId,
    auctionEnded: r.auction.status === 'ENDED',
    winnerId: r.auction.winnerId,
    auctionEndTime: r.auction.endTime,
  }));

  let flagged = 0;
  for (const s of scanBids(bids)) {
    if (await upsertSignal(s)) flagged++;
  }
  return { scanned: rows.length, flagged };
}
