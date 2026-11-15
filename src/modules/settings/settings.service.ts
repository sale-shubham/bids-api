import { prisma } from '@/core/prisma/client';
import { CHECKOUT_MODE_KEY, DEFAULT_CHECKOUT_MODE, parseCheckoutMode, type CheckoutMode } from './checkout-mode.constants';
import { DEPOSIT_RATE_KEY, DEPOSIT_THRESHOLD_KEY, parseDepositConfig } from '@/modules/deposits/deposits.rules';
import {
  FEATURED_ENABLED_KEY,
  FEATURED_PRICES_KEY,
  parseFeaturedEnabled,
  parseFeaturePrices,
  type FeaturePrices,
} from '@/modules/featured/featured.rules';
import { REFERRAL_ENABLED_KEY, REFERRAL_MAX_KEY, REFERRAL_REWARD_KEY, parseReferralConfig } from '@/modules/referrals/referrals.rules';
import { logger } from '@/core/logger/logger';
import { activeRootCategoryNames } from '@/modules/categories/categories.service';
import { DEFAULT_MAX_PRICE_PAISE, HARD_MAX_PRICE_PAISE, MAX_PRICE_SETTING_KEY, MIN_MAX_PRICE_PAISE } from '@/core/money';

// Admin-managed app settings live in the AppSetting key/value table
// (`value` is TEXT, parsed by each caller). Typed settings (commission rate,
// anti-sniping minutes, ...) are added here in later phases.

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

// ---------------------------------------------------------------- platform settings

export const SETTING_KEYS = {
  commissionRateBps: 'commission.rateBps',
  minIncrementPaise: 'auction.minIncrementPaise',
  antiSnipingMinutes: 'auction.antiSnipingMinutes',
  maxPricePaise: MAX_PRICE_SETTING_KEY,
  checkoutMode: CHECKOUT_MODE_KEY,
  depositThresholdPaise: DEPOSIT_THRESHOLD_KEY,
  depositRateBps: DEPOSIT_RATE_KEY,
  featuredEnabled: FEATURED_ENABLED_KEY,
  featuredPrices: FEATURED_PRICES_KEY,
  referralEnabled: REFERRAL_ENABLED_KEY,
  referralRewardPaise: REFERRAL_REWARD_KEY,
  referralMaxRewardsPerMember: REFERRAL_MAX_KEY,
} as const;

export interface PlatformSettings {
  commissionRateBps: number;
  minIncrementPaise: number;
  antiSnipingMinutes: number;
  maxPricePaise: number;
  categories: string[];
  checkoutMode: CheckoutMode;
  /** Starting bid from which an auction needs a bid deposit; 0 = deposits off. */
  depositThresholdPaise: number;
  /** Deposit as a share of the starting bid, in basis points. */
  depositRateBps: number;
  /** Paid featured listings: on/off and the paise price per 1 / 3 / 7 days. */
  featuredEnabled: boolean;
  featuredPrices: FeaturePrices;
  /** Referral credits: on/off, reward per qualified referral, cap of rewarded referrals per member. */
  referralEnabled: boolean;
  referralRewardPaise: number;
  referralMaxRewardsPerMember: number;
}

export const SETTING_DEFAULTS = {
  commissionRateBps: 500,
  minIncrementPaise: 10_000,
  antiSnipingMinutes: 2,
  maxPricePaise: DEFAULT_MAX_PRICE_PAISE,
  checkoutMode: DEFAULT_CHECKOUT_MODE,
} as const;

const intOr = (raw: string | null | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export async function getPlatformSettings(): Promise<PlatformSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(SETTING_KEYS) } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const deposit = parseDepositConfig(map.get(SETTING_KEYS.depositThresholdPaise), map.get(SETTING_KEYS.depositRateBps));
  const referral = parseReferralConfig(
    map.get(SETTING_KEYS.referralEnabled),
    map.get(SETTING_KEYS.referralRewardPaise),
    map.get(SETTING_KEYS.referralMaxRewardsPerMember),
  );
  return {
    commissionRateBps: intOr(map.get(SETTING_KEYS.commissionRateBps), SETTING_DEFAULTS.commissionRateBps, 0, 10_000),
    minIncrementPaise: intOr(map.get(SETTING_KEYS.minIncrementPaise), SETTING_DEFAULTS.minIncrementPaise, 100, HARD_MAX_PRICE_PAISE),
    antiSnipingMinutes: intOr(map.get(SETTING_KEYS.antiSnipingMinutes), SETTING_DEFAULTS.antiSnipingMinutes, 0, 30),
    maxPricePaise: intOr(map.get(SETTING_KEYS.maxPricePaise), SETTING_DEFAULTS.maxPricePaise, MIN_MAX_PRICE_PAISE, HARD_MAX_PRICE_PAISE),
    categories: await activeRootCategoryNames(),
    checkoutMode: parseCheckoutMode(map.get(SETTING_KEYS.checkoutMode)),
    depositThresholdPaise: deposit.thresholdPaise,
    depositRateBps: deposit.rateBps,
    featuredEnabled: parseFeaturedEnabled(map.get(SETTING_KEYS.featuredEnabled)),
    featuredPrices: parseFeaturePrices(map.get(SETTING_KEYS.featuredPrices)),
    referralEnabled: referral.enabled,
    referralRewardPaise: referral.rewardPaise,
    referralMaxRewardsPerMember: referral.maxRewardsPerMember,
  };
}

// maxPricePaise, checkoutMode, the deposit, featured and referral settings are optional on write: old admin clients omit them and the stored value stays.
export async function setPlatformSettings(
  input: Omit<
    PlatformSettings,
    | 'categories'
    | 'maxPricePaise'
    | 'checkoutMode'
    | 'depositThresholdPaise'
    | 'depositRateBps'
    | 'featuredEnabled'
    | 'featuredPrices'
    | 'referralEnabled'
    | 'referralRewardPaise'
    | 'referralMaxRewardsPerMember'
  > & {
    /** Deprecated and ignored: categories are the Category table now (admin/categories). */
    categories?: string[];
    maxPricePaise?: number;
    checkoutMode?: CheckoutMode;
    depositThresholdPaise?: number;
    depositRateBps?: number;
    featuredEnabled?: boolean;
    featuredPrices?: FeaturePrices;
    referralEnabled?: boolean;
    referralRewardPaise?: number;
    referralMaxRewardsPerMember?: number;
  },
): Promise<PlatformSettings> {
  const entries: [string, string][] = [
    [SETTING_KEYS.commissionRateBps, String(input.commissionRateBps)],
    [SETTING_KEYS.minIncrementPaise, String(input.minIncrementPaise)],
    [SETTING_KEYS.antiSnipingMinutes, String(input.antiSnipingMinutes)],
  ];
  if (input.categories !== undefined) logger.debug('settings: `categories` is deprecated and ignored; manage /admin/categories');
  if (input.maxPricePaise !== undefined) entries.push([SETTING_KEYS.maxPricePaise, String(input.maxPricePaise)]);
  if (input.checkoutMode !== undefined) entries.push([SETTING_KEYS.checkoutMode, input.checkoutMode]);
  if (input.depositThresholdPaise !== undefined) entries.push([SETTING_KEYS.depositThresholdPaise, String(input.depositThresholdPaise)]);
  if (input.depositRateBps !== undefined) entries.push([SETTING_KEYS.depositRateBps, String(input.depositRateBps)]);
  if (input.featuredEnabled !== undefined) entries.push([SETTING_KEYS.featuredEnabled, String(input.featuredEnabled)]);
  if (input.featuredPrices !== undefined) entries.push([SETTING_KEYS.featuredPrices, JSON.stringify(input.featuredPrices)]);
  if (input.referralEnabled !== undefined) entries.push([SETTING_KEYS.referralEnabled, String(input.referralEnabled)]);
  if (input.referralRewardPaise !== undefined) entries.push([SETTING_KEYS.referralRewardPaise, String(input.referralRewardPaise)]);
  if (input.referralMaxRewardsPerMember !== undefined) entries.push([SETTING_KEYS.referralMaxRewardsPerMember, String(input.referralMaxRewardsPerMember)]);
  await prisma.$transaction(
    entries.map(([key, value]) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })),
  );
  return getPlatformSettings();
}
