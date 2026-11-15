import Joi from 'joi';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

// Allowed image types → file extension for the presigned-upload flow.
export const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
export const VIDEO_FOLDER = 'auction-videos';

// Videos are accepted only for the auction-videos folder.
export const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

/** File extension for any allowed upload content type. */
export const UPLOAD_EXTENSIONS: Record<string, string> = { ...IMAGE_TYPES, ...VIDEO_TYPES };

const contentTypeFor = (types: Record<string, string>, message: string) =>
  Joi.string().valid(...Object.keys(types)).messages({ 'any.only': message });

// The folder decides the allowed types and the size cap: videos only in auction-videos (50 MB), images elsewhere (5 MB).
export const presignSchema = Joi.object({
  folder: Joi.string().valid('auctions', 'avatars', VIDEO_FOLDER).required(),
  contentType: Joi.when('folder', {
    is: VIDEO_FOLDER,
    then: contentTypeFor(VIDEO_TYPES, 'auction-videos accepts only video/mp4 or video/webm').required(),
    otherwise: contentTypeFor(IMAGE_TYPES, 'contentType must be image/jpeg, image/png or image/webp').required(),
  }),
  size: Joi.when('folder', {
    is: VIDEO_FOLDER,
    then: Joi.number().integer().min(1).max(MAX_VIDEO_BYTES).required().messages({ 'number.max': 'size must be at most 50 MB' }),
    otherwise: Joi.number().integer().min(1).max(MAX_UPLOAD_BYTES).required().messages({ 'number.max': 'size must be at most 5 MB' }),
  }),
});
