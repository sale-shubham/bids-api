import Joi from 'joi';
import { NOTIFY_TYPES } from '@/modules/notify/notify.types';

export const updatePreferencesSchema = Joi.object({
  items: Joi.array()
    .items(
      Joi.object({
        type: Joi.string().valid(...NOTIFY_TYPES).required(),
        email: Joi.boolean().required(),
        push: Joi.boolean().required(),
      }),
    )
    .min(1)
    .max(NOTIFY_TYPES.length)
    .unique('type')
    .required(),
});
