import Joi from 'joi';

// POST /admin/strikes/:id/remove
export const removeStrikeBody = Joi.object({
  note: Joi.string().trim().max(500).allow(''),
});
