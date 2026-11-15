import Joi from 'joi';

export const rangeQuerySchema = Joi.object({
  days: Joi.number().valid(7, 30, 90).default(30),
});

export const viewBodySchema = Joi.object({});
