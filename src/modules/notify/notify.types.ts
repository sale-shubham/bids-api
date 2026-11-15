export const NOTIFY_TYPES = ['outbid', 'auction-won', 'auction-sold', 'auction-unsold', 'reserve-not-met', 'commission-due', 'commission-paid', 'ending-soon', 'review-received', 'question-asked', 'question-answered', 'saved-search-match', 'sale-receipt', 'sale-paid', 'sale-shipped', 'sale-released', 'sale-disputed', 'sale-refunded', 'sale-cancelled', 'report-filed', 'deposit-held', 'deposit-refunded', 'deposit-forfeited', 'strike-issued', 'account-suspended', 'second-chance-offer', 'second-chance-accepted', 'second-chance-declined', 'shill-flag', 'followed-seller-listed'] as const;
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
