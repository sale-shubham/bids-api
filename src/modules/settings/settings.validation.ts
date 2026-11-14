import Joi from 'joi';

// PUT /admin/settings — the whole object is replaced.
export const platformSettingsSchema = Joi.object({
  commissionRateBps: Joi.number().integer().min(0).max(3000).required(),
  minIncrementPaise: Joi.number().integer().min(100).max(2_000_000_000).required(),
  antiSnipingMinutes: Joi.number().integer().min(0).max(30).required(),
  categories: Joi.array()
    .items(Joi.string().trim().min(2).max(40))
    .min(1)
    .max(30)
    .unique((a: string, b: string) => a.toLowerCase() === b.toLowerCase())
    .required(),
});

export const legalSlugParamSchema = (slugs: readonly string[]) =>
  Joi.object({ slug: Joi.string().valid(...slugs).required() });

// PUT /admin/settings/legal/:slug
export const legalPageBodySchema = Joi.object({
  title: Joi.string().trim().min(2).max(120).required(),
  content: Joi.string().min(1).max(200_000).required(),
});
