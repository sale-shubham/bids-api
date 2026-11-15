// Pure deposit rules - no I/O, unit-tested.

export const MIN_STRIKE_DEPOSIT_PAISE = 50_000;
export const STRIKES_FOR_DEPOSITS = 2;

export const DEPOSIT_THRESHOLD_KEY = 'auction.depositThresholdPaise';
export const DEPOSIT_RATE_KEY = 'auction.depositRateBps';
export const DEPOSIT_DEFAULTS = { thresholdPaise: 10_000_000, rateBps: 1000 } as const;
export const DEPOSIT_RATE_RANGE = { min: 100, max: 5000 } as const;
export const MAX_THRESHOLD_PAISE = 1_000_000_000_000;

const intIn = (raw: string | null | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** Stored settings -> config; a missing or out-of-range value falls back to the default. threshold 0 = deposits off. */
export function parseDepositConfig(thresholdRaw: string | null | undefined, rateRaw: string | null | undefined): DepositConfig {
  return {
    thresholdPaise: intIn(thresholdRaw, DEPOSIT_DEFAULTS.thresholdPaise, 0, MAX_THRESHOLD_PAISE),
    rateBps: intIn(rateRaw, DEPOSIT_DEFAULTS.rateBps, DEPOSIT_RATE_RANGE.min, DEPOSIT_RATE_RANGE.max),
  };
}

export type DepositStatusValue = 'PENDING' | 'HELD' | 'REFUNDED' | 'FORFEITED';
export type DepositConfig = { thresholdPaise: number; rateBps: number };

const share = (paise: number, rateBps: number) => Math.round((paise * rateBps) / 10_000);

/** Auction deposit: rate x starting bid when deposits are on and the starting bid reaches the threshold, else null. */
export function computeDepositPaise(startingBidPaise: number, cfg: DepositConfig): number | null {
  if (!(cfg.thresholdPaise > 0) || startingBidPaise < cfg.thresholdPaise) return null;
  const d = share(startingBidPaise, cfg.rateBps);
  return d > 0 ? d : null;
}

/** What a bidder must hold: the auction's own deposit, else a strike-based one (2+ active strikes), else 0. */
export function requiredDepositPaise(input: {
  auctionDepositPaise: number | null;
  activeStrikes: number;
  startingBidPaise: number;
  currentBidPaise: number;
  rateBps: number;
}): number {
  if (input.auctionDepositPaise !== null && input.auctionDepositPaise > 0) return input.auctionDepositPaise;
  if (input.activeStrikes >= STRIKES_FOR_DEPOSITS) {
    return Math.max(share(Math.max(input.startingBidPaise, input.currentBidPaise), input.rateBps), MIN_STRIKE_DEPOSIT_PAISE);
  }
  return 0;
}

export type ReleaseDecision = 'REFUND' | 'FORFEIT' | 'WAIT';

/** What to do with a HELD deposit once the auction state is known. `saleStatus` = the member's latest sale on it. */
export function releaseDecision(input: {
  auctionStatus: 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED';
  auctionDeleted: boolean;
  winnerId: string | null;
  memberId: string;
  saleStatus: string | null;
}): ReleaseDecision {
  if (input.auctionStatus === 'CANCELLED' || input.auctionDeleted) return 'REFUND';
  if (input.auctionStatus !== 'ENDED') return 'WAIT';
  if (input.winnerId !== input.memberId) return 'REFUND';
  if (input.saleStatus === null) return 'REFUND'; // legacy mode: no Sale was created at close
  if (input.saleStatus === 'CANCELLED') return 'FORFEIT';
  if (input.saleStatus === 'AWAITING_PAYMENT') return 'WAIT';
  return 'REFUND';
}
