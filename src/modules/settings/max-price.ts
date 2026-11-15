import { AppError } from '@/core/errors/AppError';
import { DEFAULT_MAX_PRICE_PAISE, HARD_MAX_PRICE_PAISE, MAX_PRICE_SETTING_KEY, MIN_MAX_PRICE_PAISE } from '@/core/money';
import { getSetting } from './settings.service';

/** Admin-set price ceiling (paise); falls back to the default when unset or out of range. */
export async function getMaxPricePaise(): Promise<number> {
  const n = Number.parseInt((await getSetting(MAX_PRICE_SETTING_KEY)) ?? '', 10);
  return Number.isSafeInteger(n) && n >= MIN_MAX_PRICE_PAISE && n <= HARD_MAX_PRICE_PAISE ? n : DEFAULT_MAX_PRICE_PAISE;
}

export function assertWithinMaxPrice(maxPaise: number, ...pricesPaise: (number | undefined)[]): void {
  if (pricesPaise.some((p) => p !== undefined && p > maxPaise)) {
    throw new AppError(400, 'PRICE_TOO_HIGH', 'Price is above the platform maximum', { maxPaise });
  }
}
