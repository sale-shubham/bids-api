import Joi from 'joi';
import { FEATURE_DAYS } from './featured.rules';

export const featureCheckoutSchema = Joi.object({
  days: Joi.number().valid(...FEATURE_DAYS).required(),
  useCredits: Joi.boolean().default(false),
});

export const promotedQuerySchema = Joi.object({
  category: Joi.string().trim().max(100),
  limit: Joi.number().integer().min(1).max(4).default(2),
});
