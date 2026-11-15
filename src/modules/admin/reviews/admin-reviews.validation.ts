import Joi from 'joi';

export const listReviewsQuery = Joi.object({
  hidden: Joi.boolean().optional(),
  q: Joi.string().trim().allow('').max(100).optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100),
  pageSize: Joi.number().integer().min(1).max(100),
});

export const hideReviewBody = Joi.object({
  hidden: Joi.boolean().required(),
});
