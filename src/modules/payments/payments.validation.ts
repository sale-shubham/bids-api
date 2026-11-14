import Joi from 'joi';

export const verifySchema = Joi.object({
  orderId: Joi.string().trim().max(100).required(),
  paymentId: Joi.string().trim().max(100).required(),
  signature: Joi.string().trim().max(256).required(),
});
