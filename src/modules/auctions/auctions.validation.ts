import Joi from 'joi';
import sanitizeHtml from 'sanitize-html';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';
import { isOwnMediaUrl } from '@/modules/members/members.service';
import { CONDITIONS, type Condition, type ShippingOptions } from './listing.rules';

const HOUR_MS = 60 * 60 * 1000;
export const MIN_DURATION_MS = HOUR_MS;
export const MAX_DURATION_MS = 30 * 24 * HOUR_MS;
export const START_GRACE_MS = 2 * 60 * 1000; // startTime may be up to 2 min in the past
export const MIN_STARTING_BID_PAISE = 100;
export const MAX_STARTING_BID_PAISE = HARD_MAX_PRICE_PAISE;
export const MIN_INCREMENT_PAISE = 100;
export const MAX_IMAGES = 8;
export const MAX_BULK_ITEMS = 50;

/**
 * Time rules shared by create / patch / republish. Returns an error message,
 * or null when OK. `checkStart` = also require startTime >= now - 2 min (skip
 * when an existing, unchanged startTime is being re-checked against a new end).
 */
export function checkTimeWindow(start: Date, end: Date, now = new Date(), checkStart = true): string | null {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'startTime and endTime must be valid dates';
  if (checkStart && start.getTime() < now.getTime() - START_GRACE_MS) return 'startTime cannot be in the past';
  const span = end.getTime() - start.getTime();
  if (span < MIN_DURATION_MS) return 'endTime must be at least 1 hour after startTime';
  if (span > MAX_DURATION_MS) return 'endTime must be at most 30 days after startTime';
  return null;
}

// ---- Sanitiser (server-side allow-list; the client's editor output is never trusted) ----
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'blockquote', 'a'],
  allowedAttributes: { a: ['href', 'rel', 'target'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
  },
};

export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS).trim();
}

// ---- Schemas ----
const imageUrl = Joi.string()
  .trim()
  .uri({ scheme: ['https', 'http'] })
  .max(1000)
  .custom((value: string, helpers) =>
    isOwnMediaUrl(value) ? value : helpers.message({ custom: 'images must be uploaded images from this platform' }),
  );

const videoUrl = Joi.string()
  .trim()
  .uri({ scheme: ['https', 'http'] })
  .max(1000)
  .custom((value: string, helpers) =>
    isOwnMediaUrl(value) ? value : helpers.message({ custom: 'videoUrl must be an uploaded video from this platform' }),
  );

const MAX_ATTR_PARAMS = 5;

const fields = {
  title: Joi.string().trim().min(5).max(120),
  description: Joi.string().trim().min(20).max(10000),
  category: Joi.string().trim().min(1).max(100), // legacy alias: a category name or slug
  categoryId: Joi.string().trim().min(1).max(60),
  // Shape and per-category rules are checked by validateAttributes (400 INVALID_ATTRIBUTES).
  attributes: Joi.object().max(50).allow(null),
  condition: Joi.string().valid(...CONDITIONS),
  conditionReport: Joi.string().trim().max(20000).allow('', null),
  // Estimate rules (both-or-neither, low <= high, >= 100, ceiling) live in the service (400 INVALID_ESTIMATE).
  estimateLowPaise: Joi.number().integer().min(0).max(MAX_STARTING_BID_PAISE).allow(null),
  estimateHighPaise: Joi.number().integer().min(0).max(MAX_STARTING_BID_PAISE).allow(null),
  videoUrl: videoUrl.allow(null),
  // Validated by validateShipping (400 INVALID_SHIPPING).
  shippingOptions: Joi.object().allow(null),
  images: Joi.array().items(imageUrl).min(1).max(MAX_IMAGES),
  startingBidPaise: Joi.number().integer().min(MIN_STARTING_BID_PAISE).max(MAX_STARTING_BID_PAISE),
  minIncrementPaise: Joi.number().integer().min(MIN_INCREMENT_PAISE).max(MAX_STARTING_BID_PAISE),
  // Cross-field rules (reserve >= start, buy-now > start and >= reserve, admin ceiling) live in the service.
  reservePricePaise: Joi.number().integer().min(MIN_STARTING_BID_PAISE).max(MAX_STARTING_BID_PAISE).allow(null),
  buyNowPricePaise: Joi.number().integer().min(MIN_STARTING_BID_PAISE).max(MAX_STARTING_BID_PAISE).allow(null),
  startTime: Joi.date().iso(),
  endTime: Joi.date().iso(),
};

// When both times are present, validate the window here; when only one is
// sent on PATCH, the service re-checks it against the stored other one.
const bothTimes = (v: { startTime?: Date; endTime?: Date }, helpers: Joi.CustomHelpers) => {
  if (v.startTime && v.endTime) {
    const msg = checkTimeWindow(v.startTime, v.endTime);
    if (msg) return helpers.message({ custom: msg });
  }
  return v;
};

export const createAuctionSchema = Joi.object({
  title: fields.title.required(),
  description: fields.description.required(),
  category: fields.category,
  categoryId: fields.categoryId,
  attributes: fields.attributes.optional(),
  condition: fields.condition.required(),
  conditionReport: fields.conditionReport.optional(),
  estimateLowPaise: fields.estimateLowPaise.optional(),
  estimateHighPaise: fields.estimateHighPaise.optional(),
  videoUrl: fields.videoUrl.optional(),
  shippingOptions: fields.shippingOptions.optional(),
  images: fields.images.required(),
  startingBidPaise: fields.startingBidPaise.required(),
  minIncrementPaise: fields.minIncrementPaise.optional(),
  reservePricePaise: fields.reservePricePaise.optional(),
  buyNowPricePaise: fields.buyNowPricePaise.optional(),
  startTime: fields.startTime.required(),
  endTime: fields.endTime.required(),
})
  .or('categoryId', 'category')
  .messages({ 'object.missing': 'categoryId (or category) is required' })
  .custom(bothTimes);

export const bulkCreateSchema = Joi.object({
  // Each item is validated with createAuctionSchema in the service so errors are reported per row.
  items: Joi.array().items(Joi.object().unknown(true)).min(1).max(MAX_BULK_ITEMS).required(),
});

export const updateAuctionSchema = Joi.object(fields).min(1).custom(bothTimes);

export const republishSchema = Joi.object({
  startTime: fields.startTime.required(),
  endTime: fields.endTime.required(),
}).custom(bothTimes);

const AUCTION_STATUSES = ['live', 'upcoming', 'ended'] as const;
export const SORTS = ['endingSoon', 'newest', 'priceAsc', 'priceDesc', 'mostBids', 'recentlySold'] as const;

const paging = {
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
};

export const listQuerySchema = Joi.object({
  status: Joi.string()
    .valid(...AUCTION_STATUSES)
    .default('live'),
  category: Joi.string().trim().max(100),
  sellerId: Joi.string().trim().max(60),
  condition: Joi.string().valid(...CONDITIONS),
  sold: Joi.boolean(),
  q: Joi.string().trim().allow('').max(100),
  minPrice: Joi.number().integer().min(0),
  maxPrice: Joi.number().integer().min(0),
  verified: Joi.boolean(),
  sort: Joi.string().valid(...SORTS),
  ...paging,
})
  // attr.<key>=value (up to 5) filter the category attributes; collected into `attrs`.
  .pattern(/^attr\.[a-z][a-z0-9_]{0,39}$/, Joi.string().trim().min(1).max(200))
  .custom((v: Record<string, unknown>, helpers) => {
    if (typeof v.minPrice === 'number' && typeof v.maxPrice === 'number' && v.minPrice > v.maxPrice) {
      return helpers.message({ custom: 'minPrice cannot exceed maxPrice' });
    }
    const attrs: Record<string, string> = {};
    const rest: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith('attr.')) attrs[k.slice(5)] = String(val);
      else rest[k] = val;
    }
    if (Object.keys(attrs).length > MAX_ATTR_PARAMS) return helpers.message({ custom: `At most ${MAX_ATTR_PARAMS} attr.<key> filters are allowed` });
    return Object.keys(attrs).length ? { ...rest, attrs } : rest;
  });

export const mineQuerySchema = Joi.object({
  status: Joi.string().valid('upcoming', 'live', 'ended', 'cancelled').default('live'),
  ...paging,
});

export type CreateAuctionInput = {
  title: string;
  description: string;
  category?: string;
  categoryId?: string;
  attributes?: Record<string, string | number> | null;
  condition: Condition;
  conditionReport?: string | null;
  estimateLowPaise?: number | null;
  estimateHighPaise?: number | null;
  videoUrl?: string | null;
  shippingOptions?: ShippingOptions | null;
  images: string[];
  startingBidPaise: number;
  minIncrementPaise?: number;
  reservePricePaise?: number | null;
  buyNowPricePaise?: number | null;
  startTime: Date;
  endTime: Date;
};
export type UpdateAuctionInput = Partial<CreateAuctionInput>;
export type ListQuery = {
  status: 'live' | 'upcoming' | 'ended';
  category?: string;
  sellerId?: string;
  condition?: Condition;
  sold?: boolean;
  attrs?: Record<string, string>;
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  verified?: boolean;
  sort?: (typeof SORTS)[number];
  page: number;
  pageSize: number;
};
export type MineQuery = { status: 'upcoming' | 'live' | 'ended' | 'cancelled'; page: number; pageSize: number };
