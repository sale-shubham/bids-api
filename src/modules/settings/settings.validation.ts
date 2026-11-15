import Joi from 'joi';
import { MAX_FEATURE_PRICE_PAISE } from '@/modules/featured/featured.rules';
import { HARD_MAX_PRICE_PAISE, MIN_MAX_PRICE_PAISE } from '@/core/money';

// PUT /admin/settings — `categories` is deprecated and ignored (see /admin/categories); the whole object is replaced (maxPricePaise, checkoutMode and the deposit settings optional: absent keeps the stored value).
export const platformSettingsSchema = Joi.object({
  commissionRateBps: Joi.number().integer().min(0).max(3000).required(),
  minIncrementPaise: Joi.number().integer().min(100).max(HARD_MAX_PRICE_PAISE).required(),
  antiSnipingMinutes: Joi.number().integer().min(0).max(30).required(),
  maxPricePaise: Joi.number().integer().min(MIN_MAX_PRICE_PAISE).max(HARD_MAX_PRICE_PAISE),
  checkoutMode: Joi.string().valid('off', 'optional', 'required'),
  depositThresholdPaise: Joi.number().integer().min(0).max(HARD_MAX_PRICE_PAISE),
  depositRateBps: Joi.number().integer().min(100).max(5000),
  featuredEnabled: Joi.boolean(),
  featuredPrices: Joi.object({
    '1': Joi.number().integer().min(100).max(MAX_FEATURE_PRICE_PAISE).required(),
    '3': Joi.number().integer().min(100).max(MAX_FEATURE_PRICE_PAISE).required(),
    '7': Joi.number().integer().min(100).max(MAX_FEATURE_PRICE_PAISE).required(),
  }),
  referralEnabled: Joi.boolean(),
  referralRewardPaise: Joi.number().integer().min(100).max(100_000_000),
  referralMaxRewardsPerMember: Joi.number().integer().min(0).max(10_000),
  categories: Joi.array()
    .items(Joi.string().trim().min(2).max(40))
    .min(1)
    .max(30)
    .unique((a: string, b: string) => a.toLowerCase() === b.toLowerCase())
    .optional(),
});

export const legalSlugParamSchema = (slugs: readonly string[]) =>
  Joi.object({ slug: Joi.string().valid(...slugs).required() });

// PUT /admin/settings/legal/:slug
export const legalPageBodySchema = Joi.object({
  title: Joi.string().trim().min(2).max(120).required(),
  content: Joi.string().min(1).max(200_000).required(),
});
