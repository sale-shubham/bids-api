import Joi from 'joi';
import { GSTIN_RE, STATE_CODE_RE } from '@/modules/invoices/invoice.rules';

// Self-service profile update (PATCH /members/me). Email and role are
// immutable here; everything else on the profile is optional.
export const updateMeSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  phone: Joi.string().trim().max(30).allow('', null),
  address: Joi.string().trim().max(500).allow('', null),
  avatarUrl: Joi.string().trim().uri().max(1000).allow('', null),
  gstin: Joi.string().trim().uppercase().pattern(GSTIN_RE).allow('', null).messages({ 'string.pattern.base': 'Enter a valid 15-character GSTIN' }),
  billingState: Joi.string().trim().pattern(STATE_CODE_RE).allow('', null).messages({ 'string.pattern.base': 'billingState must be a 2-digit GST state code' }),
}).min(1);

export const creditsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});
