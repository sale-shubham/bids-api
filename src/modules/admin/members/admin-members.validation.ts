import Joi from 'joi';
import { sortOrderSchema } from '@/core/http/pagination';

export const listMembersQuery = Joi.object({
  status: Joi.string().valid('active', 'inactive').optional(),
  // true: has listed at least one auction; false: has never listed one.
  seller: Joi.boolean().optional(),
  q: Joi.string().trim().allow('').max(100).optional(),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  // `.valid()` rejects anything not listed — keep in sync with MEMBER_SORT_MAP.
  sortBy: Joi.string().valid('name', 'email', 'createdAt', 'isActive').optional(),
  sortOrder: sortOrderSchema,
});

// POST /admin/members/:id/credits: non-zero, +/- (a debit cannot take the balance below 0).
export const creditAdjustBody = Joi.object({
  amountPaise: Joi.number().integer().min(-10_000_000).max(10_000_000).invalid(0).required(),
  note: Joi.string().trim().min(3).max(200).required(),
});

// PATCH /admin/members/:id. Roles are not editable (everyone is a MEMBER; super admins come only from the seed).
export const updateMemberBody = Joi.object({
  isActive: Joi.boolean(),
  verified: Joi.boolean(),
}).min(1);
