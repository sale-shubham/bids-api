import Joi from 'joi';

export const SALE_STATUSES = ['AWAITING_PAYMENT', 'PAID', 'SHIPPED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED'] as const;

// `limit` is the documented page size; `pageSize` is accepted as an alias (the rest of the API uses it).
const paging = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100),
  pageSize: Joi.number().integer().min(1).max(100),
};

export const mineQuerySchema = Joi.object({
  role: Joi.string().valid('buyer', 'seller').default('buyer'),
  status: Joi.string().uppercase().valid(...SALE_STATUSES),
  ...paging,
});

export const adminListQuerySchema = Joi.object({
  status: Joi.string().uppercase().valid(...SALE_STATUSES),
  q: Joi.string().trim().allow('').max(100),
  ...paging,
});

export const shipSchema = Joi.object({
  method: Joi.string().valid('COURIER', 'PICKUP').required(),
  courier: Joi.string().trim().max(60).when('method', { is: 'COURIER', then: Joi.required(), otherwise: Joi.optional() }),
  trackingNo: Joi.string().trim().max(60).allow(''),
});

export const disputeSchema = Joi.object({
  reason: Joi.string().trim().min(10).max(1000).required(),
});

export const refundSchema = Joi.object({
  note: Joi.string().trim().max(500).allow(''),
});

export type SaleListQuery = { page: number; limit?: number; pageSize?: number };

/** Normalised page size from the validated `limit` / `pageSize` query. */
export const pageSizeOf = (q: SaleListQuery) => q.limit ?? q.pageSize ?? 20;
