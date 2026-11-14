import Joi from 'joi';

export const contactSchema = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  email: Joi.string().trim().lowercase().email().max(254).required(),
  subject: Joi.string().trim().min(3).max(120).required(),
  message: Joi.string().trim().min(10).max(4000).required(),
});

export type ContactInput = { name: string; email: string; subject: string; message: string };
