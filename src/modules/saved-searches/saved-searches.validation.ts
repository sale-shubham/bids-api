import Joi from 'joi';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';
import { CONDITIONS, type Condition } from '@/modules/auctions/listing.rules';

const price = Joi.number().integer().min(0).max(HARD_MAX_PRICE_PAISE);

export const createSavedSearchSchema = Joi.object({
  name: Joi.string().trim().max(60).allow('').optional(),
  q: Joi.string().trim().max(100).allow('').optional(),
  category: Joi.string().trim().max(100).allow('').optional(),
  condition: Joi.string().valid(...CONDITIONS).optional(),
  minPricePaise: price.optional(),
  maxPricePaise: price.optional(),
})
  .custom((v: { q?: string; category?: string; condition?: string; minPricePaise?: number; maxPricePaise?: number }, helpers) => {
    const has = !!v.q || !!v.category || !!v.condition || v.minPricePaise !== undefined || v.maxPricePaise !== undefined;
    if (!has) return helpers.message({ custom: 'Provide at least one of q, category, condition, minPricePaise, maxPricePaise' });
    if (v.minPricePaise !== undefined && v.maxPricePaise !== undefined && v.minPricePaise > v.maxPricePaise) {
      return helpers.message({ custom: 'minPricePaise must not exceed maxPricePaise' });
    }
    return v;
  });

export type CreateSavedSearchInput = {
  name?: string;
  q?: string;
  category?: string;
  condition?: Condition;
  minPricePaise?: number;
  maxPricePaise?: number;
};
