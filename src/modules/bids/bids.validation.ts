import Joi from 'joi';
import { BID_TABS, type BidTab } from '@/modules/auctions/bidding.rules';

const paging = {
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
};

// Max matches the Auction.startingBidPaise ceiling (and fits a Postgres INT4).
export const placeBidSchema = Joi.object({
  amountPaise: Joi.number().integer().min(1).max(2_147_483_647).required(),
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
