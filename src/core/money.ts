// Money is integer paise: Prisma BigInt in the DB, plain `number` everywhere else.
export const HARD_MAX_PRICE_PAISE = 1_000_000_000_000;
// Lowest value the admin-set auction.maxPricePaise ceiling may take (Rs 1,000).
export const MIN_MAX_PRICE_PAISE = 100_000;
// Admin-set price ceiling: AppSetting key and default (Rs 10 crore).
export const MAX_PRICE_SETTING_KEY = 'auction.maxPricePaise';
export const DEFAULT_MAX_PRICE_PAISE = 10_000_000_000;

export function toPaise(v: bigint | number): number {
  const n = typeof v === 'bigint' ? Number(v) : v;
  if (!Number.isSafeInteger(n)) throw new Error(`Paise value is not a safe integer: ${String(v)}`);
  return n;
}

export function toPaiseOrNull(v: bigint | number | null | undefined): number | null {
  return v === null || v === undefined ? null : toPaise(v);
}
