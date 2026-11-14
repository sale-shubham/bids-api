import Joi from 'joi';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

// Allowed image types → file extension for the presigned-upload flow.
export const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const presignSchema = Joi.object({
  folder: Joi.string().valid('auctions', 'avatars').required(),
  contentType: Joi.string()
    .valid(...Object.keys(IMAGE_TYPES))
    .required()
    .messages({ 'any.only': 'contentType must be image/jpeg, image/png or image/webp' }),
  size: Joi.number().integer().min(1).max(MAX_UPLOAD_BYTES).required().messages({
    'number.max': 'size must be at most 5 MB',
  }),
});
