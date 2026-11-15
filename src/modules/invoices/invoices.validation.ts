import Joi from 'joi';
import { GSTIN_RE, INVOICE_TYPES, STATE_CODE_RE } from './invoice.rules';

export const mineQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

export const adminListQuerySchema = Joi.object({
  type: Joi.string().valid(...INVOICE_TYPES),
  q: Joi.string().trim().allow('').max(100),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// PUT /admin/settings/invoice (whole object).
export const invoiceSettingsSchema = Joi.object({
  legalName: Joi.string().trim().min(2).max(200).required(),
  gstin: Joi.string().trim().uppercase().pattern(GSTIN_RE).allow('', null).messages({ 'string.pattern.base': 'Enter a valid 15-character GSTIN' }),
  address: Joi.string().trim().allow('').max(500).required(),
  stateCode: Joi.string().trim().pattern(STATE_CODE_RE).required().messages({ 'string.pattern.base': 'stateCode must be a 2-digit GST state code' }),
  gstRateBps: Joi.number().integer().min(0).max(5000).required(),
  commissionInclusive: Joi.boolean().required(),
  sacCode: Joi.string().trim().pattern(/^\d{4,8}$/).required(),
});

export type MineQuery = { page: number; pageSize: number };
export type AdminListQuery = { type?: (typeof INVOICE_TYPES)[number]; q?: string; page: number; pageSize: number };
