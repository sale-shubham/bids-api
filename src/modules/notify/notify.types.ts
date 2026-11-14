export const NOTIFY_TYPES = ['outbid', 'auction-won', 'auction-sold', 'auction-unsold', 'commission-due', 'commission-paid', 'ending-soon'] as const;
export type NotifyType = (typeof NOTIFY_TYPES)[number];

export interface NotifyMessage {
  type: NotifyType;
  memberId: string;
  auctionId?: string;
  // Small, non-PII facts (amounts, dates). Contact details are loaded at processing time.
  data?: Record<string, unknown>;
  // Idempotency key, e.g. `outbid:<bidId>:<memberId>`, `auction-won:<auctionId>`.
  dedupeKey: string;
}
