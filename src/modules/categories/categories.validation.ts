import Joi from 'joi';
import { ATTRIBUTE_KEY_RE, type AttributeDef } from './categories.rules';

const attributeDef = Joi.object({
  key: Joi.string().pattern(ATTRIBUTE_KEY_RE).required(),
  label: Joi.string().trim().min(1).max(60).required(),
  type: Joi.string().valid('text', 'number', 'select').required(),
  options: Joi.when('type', {
    is: 'select',
    then: Joi.array().items(Joi.string().trim().min(1).max(100)).min(1).max(50).unique().required(),
    otherwise: Joi.forbidden(),
  }),
  required: Joi.boolean(),
  unit: Joi.string().trim().min(1).max(12),
});

const attributeSchema = Joi.array()
  .items(attributeDef)
  .max(30)
  .unique('key')
  .messages({ 'array.unique': 'attributeSchema keys must be unique' });

const fields = {
  name: Joi.string().trim().min(1).max(60),
  slug: Joi.string()
    .trim()
    .max(60)
    .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .messages({ 'string.pattern.base': 'slug must be lower-case letters, digits and single hyphens' }),
  parentId: Joi.string().trim().max(60).allow(null),
  sortOrder: Joi.number().integer().min(0).max(100000),
  isActive: Joi.boolean(),
  description: Joi.string().trim().max(500).allow('', null),
  attributeSchema,
};

export const createCategorySchema = Joi.object({ ...fields, name: fields.name.required() });
export const updateCategorySchema = Joi.object(fields).min(1);

export type CreateCategoryInput = {
  name: string;
  slug?: string;
  parentId?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  description?: string | null;
  attributeSchema?: AttributeDef[];
};
export type UpdateCategoryInput = Partial<CreateCategoryInput>;
