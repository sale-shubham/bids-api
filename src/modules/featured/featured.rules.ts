export const FEATURE_DAYS = [1, 3, 7] as const;
export type FeatureDays = (typeof FEATURE_DAYS)[number];
export type FeaturePrices = Record<'1' | '3' | '7', number>;

export const FEATURED_ENABLED_KEY = 'featured.enabled';
export const FEATURED_PRICES_KEY = 'featured.prices';
export const DEFAULT_FEATURE_PRICES: FeaturePrices = { '1': 9900, '3': 24900, '7': 49900 };
export const MAX_FEATURE_PRICE_PAISE = 100_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

const validPrice = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 100 && v <= MAX_FEATURE_PRICE_PAISE;

/** Stored JSON -> prices; any missing or invalid tier falls back to its default. */
export function parseFeaturePrices(raw: string | null | undefined): FeaturePrices {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  const out = { ...DEFAULT_FEATURE_PRICES };
  for (const d of FEATURE_DAYS) {
    const v = parsed?.[String(d)];
    if (validPrice(v)) out[String(d) as keyof FeaturePrices] = v;
  }
  return out;
}

export const parseFeaturedEnabled = (raw: string | null | undefined): boolean => raw !== 'false';

/** featuredUntil = min(max(now, current) + days, auction end). */
export function applyFeatureDays(now: Date, current: Date | null, days: number, endTime: Date): Date {
  const base = current && current.getTime() > now.getTime() ? current : now;
  const next = base.getTime() + days * DAY_MS;
  return new Date(Math.min(next, endTime.getTime()));
}

export const isPromoted = (a: { featuredUntil?: Date | null }, now: Date): boolean => !!a.featuredUntil && a.featuredUntil.getTime() > now.getTime();
