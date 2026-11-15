import Joi from 'joi';

export const createReviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().max(1000).allow('').optional(),
});

export const replySchema = Joi.object({
  reply: Joi.string().trim().min(1).max(1000).required(),
});

// `limit` is the documented name; `pageSize` is the repo-wide alias.
export const reviewListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100),
  pageSize: Joi.number().integer().min(1).max(100),
});

export type ReviewListQuery = { page: number; limit?: number; pageSize?: number };

export function resolvePaging(q: { page: number; limit?: number; pageSize?: number }) {
  return { page: q.page, pageSize: q.limit ?? q.pageSize ?? 20 };
}
