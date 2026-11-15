// Pure shill-bid scoring - no I/O, unit-tested. Signals are review-only: nothing here blocks a bid.

export const RISK_THRESHOLD = 50;
export const SESSION_WINDOW_DAYS = 30;
export const NEW_ACCOUNT_DAYS = 7;
export const SCAN_WINDOW_DAYS = 90;
export const DAY_MS = 86_400_000;

export const SCORES = {
  SHARED_DEVICE: 50,
  SHARED_IP: 30,
  NEW_ACCOUNT_SINGLE_SELLER: 20,
  CONCENTRATION: 40,
  NEVER_WINS: 30,
} as const;
export type RiskReason = keyof typeof SCORES;

export type Scored = { score: number; reasons: RiskReason[] };

export const scoreOf = (reasons: readonly RiskReason[]) => reasons.reduce((sum, r) => sum + SCORES[r], 0);

/** Live check after a bid: shared device / ip with the seller, brand-new account that only bids on this seller. */
export function scoreBidRisk(f: {
  sharedDevice: boolean;
  sharedIp: boolean;
  accountAgeMs: number;
  bidsTotal: number;
  bidsOnSeller: number;
}): Scored {
  const reasons: RiskReason[] = [];
  if (f.sharedDevice) reasons.push('SHARED_DEVICE');
  if (f.sharedIp) reasons.push('SHARED_IP');
  if (f.accountAgeMs < NEW_ACCOUNT_DAYS * DAY_MS && f.bidsTotal > 0 && f.bidsOnSeller === f.bidsTotal) {
    reasons.push('NEW_ACCOUNT_SINGLE_SELLER');
  }
  return { score: scoreOf(reasons), reasons };
}

/** Existing signal + new check: keep the max score, union the reasons. */
export function mergeSignal(existing: { score: number; reasons: unknown } | null, next: Scored): Scored {
  const old = Array.isArray(existing?.reasons) ? (existing!.reasons as RiskReason[]) : [];
  return {
    score: Math.max(existing?.score ?? 0, next.score),
    reasons: [...new Set([...old, ...next.reasons])] as RiskReason[],
  };
}

export type ScanBid = {
  bidderId: string;
  auctionId: string;
  sellerId: string;
  auctionEnded: boolean;
  winnerId: string | null;
  auctionEndTime: Date;
};
export type ScanSignal = { bidderId: string; sellerId: string; auctionId: string } & Scored;

/**
 * Daily scan over recent bids. Per (bidder, seller): CONCENTRATION when the bidder has >= 5 bids and more than 70%
 * of them are on this seller; NEVER_WINS when they bid on >= 3 of the seller's ended auctions and won none.
 * `auctionId` is the seller's latest auction (by end time) the bidder bid on. Only pairs at the threshold are returned.
 */
export function scanBids(bids: readonly ScanBid[]): ScanSignal[] {
  const byBidder = new Map<string, ScanBid[]>();
  for (const b of bids) byBidder.set(b.bidderId, [...(byBidder.get(b.bidderId) ?? []), b]);

  const out: ScanSignal[] = [];
  for (const [bidderId, rows] of byBidder) {
    const bySeller = new Map<string, ScanBid[]>();
    for (const r of rows) bySeller.set(r.sellerId, [...(bySeller.get(r.sellerId) ?? []), r]);

    for (const [sellerId, sellerRows] of bySeller) {
      const reasons: RiskReason[] = [];
      if (rows.length >= 5 && sellerRows.length / rows.length > 0.7) reasons.push('CONCENTRATION');

      const ended = new Map<string, ScanBid>();
      for (const r of sellerRows) if (r.auctionEnded) ended.set(r.auctionId, r);
      if (ended.size >= 3 && [...ended.values()].every((r) => r.winnerId !== bidderId)) reasons.push('NEVER_WINS');

      const score = scoreOf(reasons);
      if (score < RISK_THRESHOLD) continue;
      const latest = sellerRows.reduce((a, b) => (b.auctionEndTime.getTime() > a.auctionEndTime.getTime() ? b : a));
      out.push({ bidderId, sellerId, auctionId: latest.auctionId, score, reasons });
    }
  }
  return out;
}
