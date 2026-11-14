import Joi from 'joi';

export const mineQuerySchema = Joi.object({
  status: Joi.string().valid('due', 'paid', 'waived', 'all').default('due'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
});

export type MineQuery = { status: 'due' | 'paid' | 'waived' | 'all'; page: number; pageSize: number };
