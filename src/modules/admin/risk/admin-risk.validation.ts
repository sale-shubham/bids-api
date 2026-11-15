import Joi from 'joi';

export const listRiskQuery = Joi.object({
  status: Joi.string().valid('open', 'reviewed').default('open'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

// PATCH /admin/risk/:id
export const reviewRiskBody = Joi.object({
  outcome: Joi.string().valid('DISMISSED', 'ACTION_TAKEN').required(),
  note: Joi.string().trim().max(500).allow(''),
});
