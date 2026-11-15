import type { NotifyType } from './notify.types';

export type NotifyGroup = 'Bidding' | 'Selling' | 'Payments' | 'Community' | 'Account' | 'Admin';
export type CatalogueEntry = { label: string; group: NotifyGroup; adminOnly?: boolean };

export const NOTIFY_CATALOGUE: Record<NotifyType, CatalogueEntry> = {
  outbid: { label: 'You were outbid', group: 'Bidding' },
  'ending-soon': { label: 'Watched auction ending soon', group: 'Bidding' },
  'auction-won': { label: 'You won an auction', group: 'Bidding' },
  'reserve-not-met': { label: 'Auction ended below the reserve', group: 'Bidding' },
  'second-chance-offer': { label: 'Second-chance offer', group: 'Bidding' },
  'auction-sold': { label: 'Your auction sold', group: 'Selling' },
  'auction-unsold': { label: 'Your auction ended unsold', group: 'Selling' },
  'review-received': { label: 'New review on your profile', group: 'Selling' },
  'question-asked': { label: 'Question on your lot', group: 'Selling' },
  'second-chance-accepted': { label: 'Second-chance offer accepted', group: 'Selling' },
  'second-chance-declined': { label: 'Second-chance offer declined', group: 'Selling' },
  'commission-due': { label: 'Commission due', group: 'Payments' },
  'commission-paid': { label: 'Commission paid', group: 'Payments' },
  'sale-receipt': { label: 'Payment receipt', group: 'Payments' },
  'sale-paid': { label: 'Buyer paid for your item', group: 'Payments' },
  'sale-shipped': { label: 'Item shipped', group: 'Payments' },
  'sale-released': { label: 'Payout released', group: 'Payments' },
  'sale-disputed': { label: 'Sale disputed', group: 'Payments' },
  'sale-refunded': { label: 'Payment refunded', group: 'Payments' },
  'sale-cancelled': { label: 'Sale cancelled', group: 'Payments' },
  'deposit-held': { label: 'Bid deposit held', group: 'Payments' },
  'deposit-refunded': { label: 'Bid deposit refunded', group: 'Payments' },
  'deposit-forfeited': { label: 'Bid deposit forfeited', group: 'Payments' },
  'feature-activated': { label: 'Featured listing activated', group: 'Selling' },
  'invoice-issued': { label: 'Invoice issued', group: 'Payments' },
  'referral-rewarded': { label: 'Referral reward credited', group: 'Account' },
  'question-answered': { label: 'Your question was answered', group: 'Community' },
  'saved-search-match': { label: 'New listing matches a saved search', group: 'Community' },
  'followed-seller-listed': { label: 'A seller you follow listed an item', group: 'Community' },
  'strike-issued': { label: 'Strike issued', group: 'Account' },
  'account-suspended': { label: 'Account suspended', group: 'Account' },
  'report-filed': { label: 'New report filed', group: 'Admin', adminOnly: true },
  'shill-flag': { label: 'Shill-bid flag', group: 'Admin', adminOnly: true },
};

const MANDATORY_PREFIXES = ['sale-', 'deposit-'];
const MANDATORY_EXACT = ['commission-due', 'commission-paid', 'strike-issued', 'account-suspended', 'auction-won', 'second-chance-offer', 'invoice-issued'];

/** Email cannot be turned off for these (money, account and win notices). */
export const isMandatoryEmail = (type: string): boolean =>
  MANDATORY_EXACT.includes(type) || MANDATORY_PREFIXES.some((p) => type.startsWith(p));

export const isNotifyType = (type: string): type is NotifyType => Object.prototype.hasOwnProperty.call(NOTIFY_CATALOGUE, type);

export type Pref = { email: boolean; push: boolean };
export const DEFAULT_PREF: Pref = { email: true, push: true };

/** Which channels to use for one delivery; a missing preference row means the defaults. */
export function resolveChannels(input: { type: NotifyType; pref: Partial<Pref> | null | undefined }): Pref {
  const { type, pref } = input;
  const email = isMandatoryEmail(type) ? true : (pref?.email ?? DEFAULT_PREF.email);
  const push = pref?.push ?? DEFAULT_PREF.push;
  return { email, push };
}
