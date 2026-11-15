import { AppError } from '@/core/errors/AppError';
import type { FieldError } from '@/modules/categories/categories.rules';

export const CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'USED', 'FOR_PARTS'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const MIN_ESTIMATE_PAISE = 100;
export const CONDITION_REPORT_MAX = 5000;
export const MAX_SHIPPING_FEE_PAISE = 10_000_000;

export type ShippingOptions = {
  pickup: boolean;
  pickupCity?: string;
  courier: boolean;
  shippingFeePaise?: number;
  shipsWithinDays?: number;
};

const invalidEstimate = (message: string) => new AppError(400, 'INVALID_ESTIMATE', message, [{ field: 'estimateLowPaise', message }]);

/** Both or neither; low <= high; >= 100 paise; <= the admin ceiling. */
export function assertEstimate(low: number | null | undefined, high: number | null | undefined, maxPaise: number) {
  if ((low == null) !== (high == null)) throw invalidEstimate('Provide both estimateLowPaise and estimateHighPaise, or neither');
  if (low == null || high == null) return;
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < MIN_ESTIMATE_PAISE || high < MIN_ESTIMATE_PAISE) {
    throw invalidEstimate('Estimates must be whole paise of at least 100');
  }
  if (low > high) throw invalidEstimate('estimateLowPaise cannot exceed estimateHighPaise');
  if (high > maxPaise) throw invalidEstimate('Estimate is above the platform maximum');
}

export type ShippingResult = { ok: true; value: ShippingOptions } | { ok: false; fields: FieldError[] };

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Pure validation of `shippingOptions`; unknown keys are dropped, courier-only / pickup-only fields are cleared when that option is off. */
export function validateShipping(input: unknown): ShippingResult {
  const fields: FieldError[] = [];
  const err = (field: string, message: string) => fields.push({ field: `shippingOptions.${field}`, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, fields: [{ field: 'shippingOptions', message: 'shippingOptions must be an object' }] };
  const o = input as Record<string, unknown>;
  const pickup = o.pickup ?? false;
  const courier = o.courier ?? false;
  if (typeof pickup !== 'boolean') err('pickup', 'pickup must be true or false');
  if (typeof courier !== 'boolean') err('courier', 'courier must be true or false');
  if (pickup === false && courier === false) err('pickup', 'Offer at least one of pickup or courier');

  const value: ShippingOptions = { pickup: pickup === true, courier: courier === true };
  if (pickup === true) {
    const city = typeof o.pickupCity === 'string' ? o.pickupCity.trim() : '';
    if (!city || city.length > 60) err('pickupCity', 'pickupCity is required (up to 60 characters) when pickup is offered');
    else value.pickupCity = city;
  }
  if (courier === true && o.shippingFeePaise !== undefined && o.shippingFeePaise !== null) {
    if (!isInt(o.shippingFeePaise, 0, MAX_SHIPPING_FEE_PAISE)) err('shippingFeePaise', `shippingFeePaise must be an integer from 0 to ${MAX_SHIPPING_FEE_PAISE}`);
    else value.shippingFeePaise = o.shippingFeePaise;
  }
  if (o.shipsWithinDays !== undefined && o.shipsWithinDays !== null) {
    if (!isInt(o.shipsWithinDays, 1, 30)) err('shipsWithinDays', 'shipsWithinDays must be an integer from 1 to 30');
    else value.shipsWithinDays = o.shipsWithinDays;
  }
  return fields.length ? { ok: false, fields } : { ok: true, value };
}

export function assertShipping(input: unknown): ShippingOptions {
  const r = validateShipping(input);
  if (!r.ok) throw new AppError(400, 'INVALID_SHIPPING', r.fields[0].message, r.fields);
  return r.value;
}

export type ShippingDTO = { pickup: boolean; pickupCity: string | null; courier: boolean; shippingFeePaise: number | null; shipsWithinDays: number | null };

/** Stored JSON -> API shape from named fields; null when absent or malformed (legacy auctions). */
export function toShippingDTO(raw: unknown): ShippingDTO | null {
  if (raw === null || raw === undefined) return null;
  const r = validateShipping(raw);
  if (!r.ok) return null;
  const v = r.value;
  return {
    pickup: v.pickup,
    pickupCity: v.pickupCity ?? null,
    courier: v.courier,
    shippingFeePaise: v.shippingFeePaise ?? null,
    shipsWithinDays: v.shipsWithinDays ?? null,
  };
}
