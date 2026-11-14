import Joi from 'joi';

// Self-service profile update (PATCH /members/me). Email and role are
// immutable here; everything else on the profile is optional.
export const updateMeSchema = Joi.object({
  name: Joi.string().trim().min(1).max(200),
  phone: Joi.string().trim().max(30).allow('', null),
  address: Joi.string().trim().max(500).allow('', null),
  avatarUrl: Joi.string().trim().uri().max(1000).allow('', null),
}).min(1);
