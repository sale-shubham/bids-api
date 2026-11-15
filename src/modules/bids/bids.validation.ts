import Joi from 'joi';
import { BID_TABS, type BidTab } from '@/modules/auctions/bidding.rules';
import { HARD_MAX_PRICE_PAISE } from '@/core/money';

const paging = {
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
};

// Hard cap only; the admin-set auction.maxPricePaise ceiling is enforced in placeBid.
export const placeBidSchema = Joi.object({
  amountPaise: Joi.number().integer().min(1).max(HARD_MAX_PRICE_PAISE).required(),
});

export const listBidsQuerySchema = Joi.object({ ...paging });

export const myBidsQuerySchema = Joi.object({
  tab: Joi.string()
    .valid(...BID_TABS)
    .default('winning'),
  ...paging,
});

export type PlaceBidInput = { amountPaise: number };
export type ListBidsQuery = { page: number; pageSize: number };
export type MyBidsQuery = { tab: BidTab; page: number; pageSize: number };
