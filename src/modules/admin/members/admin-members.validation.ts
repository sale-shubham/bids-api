import Joi from 'joi';
import { sortOrderSchema } from '@/core/http/pagination';

export const listMembersQuery = Joi.object({
  status: Joi.string().valid('active', 'inactive').optional(),
  role: Joi.string().valid('BIDDER', 'AUCTIONEER', 'SUPER_ADMIN').optional(),
  q: Joi.string().trim().allow('').max(100).optional(),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  // `.valid()` rejects anything not listed — keep in sync with MEMBER_SORT_MAP.
  sortBy: Joi.string().valid('name', 'email', 'role', 'createdAt', 'isActive').optional(),
  sortOrder: sortOrderSchema,
});

// PATCH /admin/members/:id
export const updateMemberBody = Joi.object({
  isActive: Joi.boolean(),
  role: Joi.string().valid('BIDDER', 'AUCTIONEER', 'SUPER_ADMIN'),
  verified: Joi.boolean(),
}).min(1);
