import { env } from '@/core/config/env';
import type { NotifyType } from './notify.types';

/** Rs 1,23,456 / Rs 1,234.50 (Indian digit grouping, paise shown only when non-zero). */
export function formatInr(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export type Person = { name: string; email: string; phone: string | null };

export type ContentCtx = {
  type: NotifyType;
  auctionId: string;
  auctionTitle: string;
  memberName: string;
  data: Record<string, unknown>;
  counterparty?: Person | null; // seller for auction-won, winner for auction-sold
};

export type Content = {
  title: string;
  body: string;
  url: string; // in-app path
  subject: string;
  template: NotifyType;
  templateData: Record<string, unknown>;
};

const num = (v: unknown) => (typeof v === 'number' ? v : 0);
const dateText = (v: unknown) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v))
    ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
    : '';

/** Pure: in-app / push copy plus the email subject and template variables. */
export function buildContent(c: ContentCtx): Content {
  const auctionPath = `/auctions/${c.auctionId}`;
  const base = {
    name: c.memberName,
    auctionTitle: c.auctionTitle,
    auctionUrl: `${env.app.url}${auctionPath}`,
  };
  switch (c.type) {
    case 'outbid': {
      const newBid = formatInr(num(c.data.newBidPaise));
      return {
        title: 'You have been outbid',
        body: `Someone bid ${newBid} on "${c.auctionTitle}". Place a higher bid to stay in the lead.`,
        url: auctionPath,
        subject: `You have been outbid on "${c.auctionTitle}"`,
        template: 'outbid',
        templateData: { ...base, newBid, yourBid: formatInr(num(c.data.yourBidPaise)) },
      };
    }
    case 'auction-won': {
      const finalBid = formatInr(num(c.data.finalBidPaise));
      return {
        title: 'You won the auction',
        body: `You won "${c.auctionTitle}" with a bid of ${finalBid}. Contact the seller to complete the deal.`,
        url: auctionPath,
        subject: `You won "${c.auctionTitle}"`,
        template: 'auction-won',
        templateData: { ...base, finalBid, seller: c.counterparty ?? null },
      };
    }
    case 'auction-sold': {
      const finalBid = formatInr(num(c.data.finalBidPaise));
      const commission = formatInr(num(c.data.commissionPaise));
      return {
        title: 'Your auction sold',
        body: `"${c.auctionTitle}" sold for ${finalBid}. Contact the winner to complete the deal.`,
        url: auctionPath,
        subject: `Your auction "${c.auctionTitle}" sold for ${finalBid}`,
        template: 'auction-sold',
        templateData: { ...base, finalBid, commission, winner: c.counterparty ?? null },
      };
    }
    case 'auction-unsold':
      return {
        title: 'Your auction ended without bids',
        body: `"${c.auctionTitle}" ended with no bids. You can republish it.`,
        url: auctionPath,
        subject: `"${c.auctionTitle}" ended without bids`,
        template: 'auction-unsold',
        templateData: base,
      };
    case 'commission-paid': {
      const commission = formatInr(num(c.data.commissionPaise));
      const commissionPath = '/sell/commissions';
      return {
        title: 'Commission payment received',
        body: `We received your ${commission} commission payment for "${c.auctionTitle}". Thank you.`,
        url: commissionPath,
        subject: `Commission payment of ${commission} received`,
        template: 'commission-paid',
        templateData: { ...base, commission, commissionUrl: `${env.app.url}${commissionPath}` },
      };
    }
    case 'commission-due': {
      const commission = formatInr(num(c.data.commissionPaise));
      const commissionPath = '/sell/commissions';
      return {
        title: 'Commission due',
        body: `${commission} commission is due for "${c.auctionTitle}"${c.data.dueAt ? ` by ${dateText(c.data.dueAt)}` : ''}.`,
        url: commissionPath,
        subject: `Commission of ${commission} due for "${c.auctionTitle}"`,
        template: 'commission-due',
        templateData: { ...base, commission, dueDate: dateText(c.data.dueAt), commissionUrl: `${env.app.url}${commissionPath}` },
      };
    }
  }
}
