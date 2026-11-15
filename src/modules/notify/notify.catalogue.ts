import type { NotifyType } from './notify.types';

export type NotifyGroup = 'Bidding' | 'Selling' | 'Payments' | 'Community' | 'Account' | 'Admin';
export type CatalogueEntry = { label: string; group: NotifyGroup; whatsappCapable: boolean; adminOnly?: boolean };

export const NOTIFY_CATALOGUE: Record<NotifyType, CatalogueEntry> = {
  outbid: { label: 'You were outbid', group: 'Bidding', whatsappCapable: true },
  'ending-soon': { label: 'Watched auction ending soon', group: 'Bidding', whatsappCapable: true },
  'auction-won': { label: 'You won an auction', group: 'Bidding', whatsappCapable: true },
  'reserve-not-met': { label: 'Auction ended below the reserve', group: 'Bidding', whatsappCapable: false },
  'second-chance-offer': { label: 'Second-chance offer', group: 'Bidding', whatsappCapable: false },
  'auction-sold': { label: 'Your auction sold', group: 'Selling', whatsappCapable: false },
  'auction-unsold': { label: 'Your auction ended unsold', group: 'Selling', whatsappCapable: false },
  'review-received': { label: 'New review on your profile', group: 'Selling', whatsappCapable: false },
  'question-asked': { label: 'Question on your lot', group: 'Selling', whatsappCapable: false },
  'second-chance-accepted': { label: 'Second-chance offer accepted', group: 'Selling', whatsappCapable: false },
  'second-chance-declined': { label: 'Second-chance offer declined', group: 'Selling', whatsappCapable: false },
  'commission-due': { label: 'Commission due', group: 'Payments', whatsappCapable: false },
  'commission-paid': { label: 'Commission paid', group: 'Payments', whatsappCapable: false },
  'sale-receipt': { label: 'Payment receipt', group: 'Payments', whatsappCapable: false },
  'sale-paid': { label: 'Buyer paid for your item', group: 'Payments', whatsappCapable: false },
  'sale-shipped': { label: 'Item shipped', group: 'Payments', whatsappCapable: false },
  'sale-released': { label: 'Payout released', group: 'Payments', whatsappCapable: false },
  'sale-disputed': { label: 'Sale disputed', group: 'Payments', whatsappCapable: false },
  'sale-refunded': { label: 'Payment refunded', group: 'Payments', whatsappCapable: false },
  'sale-cancelled': { label: 'Sale cancelled', group: 'Payments', whatsappCapable: false },
  'deposit-held': { label: 'Bid deposit held', group: 'Payments', whatsappCapable: false },
  'deposit-refunded': { label: 'Bid deposit refunded', group: 'Payments', whatsappCapable: false },
  'deposit-forfeited': { label: 'Bid deposit forfeited', group: 'Payments', whatsappCapable: false },
  'feature-activated': { label: 'Featured listing activated', group: 'Selling', whatsappCapable: false },
  'invoice-issued': { label: 'Invoice issued', group: 'Payments', whatsappCapable: false },
  'referral-rewarded': { label: 'Referral reward credited', group: 'Account', whatsappCapable: false },
  'question-answered': { label: 'Your question was answered', group: 'Community', whatsappCapable: false },
  'saved-search-match': { label: 'New listing matches a saved search', group: 'Community', whatsappCapable: false },
  'followed-seller-listed': { label: 'A seller you follow listed an item', group: 'Community', whatsappCapable: false },
  'strike-issued': { label: 'Strike issued', group: 'Account', whatsappCapable: false },
  'account-suspended': { label: 'Account suspended', group: 'Account', whatsappCapable: false },
  'report-filed': { label: 'New report filed', group: 'Admin', whatsappCapable: false, adminOnly: true },
  'shill-flag': { label: 'Shill-bid flag', group: 'Admin', whatsappCapable: false, adminOnly: true },
};

const MANDATORY_PREFIXES = ['sale-', 'deposit-'];
const MANDATORY_EXACT = ['commission-due', 'commission-paid', 'strike-issued', 'account-suspended', 'auction-won', 'second-chance-offer', 'invoice-issued'];

/** Email cannot be turned off for these (money, account and win notices). */
export const isMandatoryEmail = (type: string): boolean =>
  MANDATORY_EXACT.includes(type) || MANDATORY_PREFIXES.some((p) => type.startsWith(p));

export const isNotifyType = (type: string): type is NotifyType => Object.prototype.hasOwnProperty.call(NOTIFY_CATALOGUE, type);

export type Pref = { email: boolean; push: boolean; whatsapp: boolean };
export const DEFAULT_PREF: Pref = { email: true, push: true, whatsapp: false };

/** Which channels to use for one delivery; a missing preference row means the defaults. */
export function resolveChannels(input: {
  type: NotifyType;
  pref: Partial<Pref> | null | undefined;
  whatsappOptIn: boolean;
  phoneVerified: boolean;
}): Pref {
  const { type, pref } = input;
  const email = isMandatoryEmail(type) ? true : (pref?.email ?? DEFAULT_PREF.email);
  const push = pref?.push ?? DEFAULT_PREF.push;
  const whatsapp = NOTIFY_CATALOGUE[type].whatsappCapable && input.whatsappOptIn && input.phoneVerified && (pref?.whatsapp ?? DEFAULT_PREF.whatsapp);
  return { email, push, whatsapp };
}
