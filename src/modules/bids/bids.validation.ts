import Joi from 'joi';
import { BID_TABS, type BidTab } from '@/modules/auctions/bidding.rules';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';

const paging = {
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
};

// Hard cap only; the admin-set auction.maxPricePaise ceiling is enforced in placeBid.
// `amountPaise` is a deprecated alias of `maxAmountPaise` (the API deploys before the app).
export const placeBidSchema = Joi.object({
  maxAmountPaise: Joi.number().integer().min(1).max(HARD_MAX_PRICE_PAISE),
  amountPaise: Joi.number().integer().min(1).max(HARD_MAX_PRICE_PAISE),
}).or('maxAmountPaise', 'amountPaise');

export const listBidsQuerySchema = Joi.object({ ...paging });

export const myBidsQuerySchema = Joi.object({
  tab: Joi.string()
    .valid(...BID_TABS)
    .default('winning'),
  ...paging,
});

export type PlaceBidInput = { maxAmountPaise?: number; amountPaise?: number };
export type ListBidsQuery = { page: number; pageSize: number };
export type MyBidsQuery = { tab: BidTab; page: number; pageSize: number };
