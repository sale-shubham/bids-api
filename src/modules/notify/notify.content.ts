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
const timeText = (v: unknown) =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v))
    ? new Date(v).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) + ' IST'
    : '';
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clip = (v: unknown, max = 200) => {
  const t = str(v).trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
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
      const saleId = str(c.data.saleId);
      if (saleId) {
        const payBy = dateText(c.data.payBy);
        const salePath = `/purchases/${saleId}`;
        return {
          title: 'You won the auction',
          body: `You won "${c.auctionTitle}" with a bid of ${finalBid}. Pay within 3 days${payBy ? ` (by ${payBy})` : ''} to secure the item.`,
          url: salePath,
          subject: `You won "${c.auctionTitle}" - pay within 3 days`,
          template: 'auction-won',
          templateData: { ...base, finalBid, seller: null, checkout: true, payBy, saleUrl: `${env.app.url}${salePath}` },
        };
      }
      return {
        title: 'You won the auction',
        body: `You won "${c.auctionTitle}" with a bid of ${finalBid}. Contact the seller to complete the deal.`,
        url: auctionPath,
        subject: `You won "${c.auctionTitle}"`,
        template: 'auction-won',
        templateData: { ...base, finalBid, seller: c.counterparty ?? null, checkout: false, payBy: '', saleUrl: '' },
      };
    }
    case 'auction-sold': {
      const finalBid = formatInr(num(c.data.finalBidPaise));
      const commission = formatInr(num(c.data.commissionPaise));
      if (c.data.checkout === true) {
        const salePath = `/sell/sales/${str(c.data.saleId)}`;
        const payBy = dateText(c.data.payBy);
        return {
          title: 'Your auction sold',
          body: `"${c.auctionTitle}" sold for ${finalBid}. The buyer has 3 days to pay; we will notify you when they do.`,
          url: salePath,
          subject: `Your auction "${c.auctionTitle}" sold for ${finalBid}`,
          template: 'auction-sold',
          templateData: { ...base, finalBid, commission, winner: null, checkout: true, payBy, saleUrl: `${env.app.url}${salePath}` },
        };
      }
      return {
        title: 'Your auction sold',
        body: `"${c.auctionTitle}" sold for ${finalBid}. Contact the winner to complete the deal.`,
        url: auctionPath,
        subject: `Your auction "${c.auctionTitle}" sold for ${finalBid}`,
        template: 'auction-sold',
        templateData: { ...base, finalBid, commission, winner: c.counterparty ?? null, checkout: false, payBy: '', saleUrl: '' },
      };
    }
    case 'ending-soon': {
      const endsAt = timeText(c.data.endTime);
      return {
        title: 'Auction ending soon',
        body: `"${c.auctionTitle}" on your watchlist ends within the hour${endsAt ? ` (${endsAt})` : ''}.`,
        url: auctionPath,
        subject: `Ending soon: "${c.auctionTitle}"`,
        template: 'ending-soon',
        templateData: { ...base, endsAt },
      };
    }
    case 'auction-unsold': {
      if (c.data.reserveNotMet === true) {
        return {
          title: 'Your auction ended below your reserve',
          body: `"${c.auctionTitle}" received bids but none reached your reserve price, so it did not sell. You can relist it.`,
          url: auctionPath,
          subject: `"${c.auctionTitle}" ended below your reserve`,
          template: 'auction-unsold',
          templateData: { ...base, reserveNotMet: true },
        };
      }
      return {
        title: 'Your auction ended without bids',
        body: `"${c.auctionTitle}" ended with no bids. You can republish it.`,
        url: auctionPath,
        subject: `"${c.auctionTitle}" ended without bids`,
        template: 'auction-unsold',
        templateData: { ...base, reserveNotMet: false },
      };
    }
    case 'reserve-not-met':
      return {
        title: 'Reserve price not met',
        body: `You had the highest bid on "${c.auctionTitle}", but it did not reach the seller's reserve price, so the item was not sold.`,
        url: auctionPath,
        subject: `Reserve not met on "${c.auctionTitle}"`,
        template: 'reserve-not-met',
        templateData: base,
      };
    case 'review-received': {
      const rating = num(c.data.rating);
      const sellerPath = `/sellers/${str(c.data.sellerId)}`;
      return {
        title: 'New review received',
        body: `A buyer rated you ${rating}/5 for "${c.auctionTitle}".`,
        url: sellerPath,
        subject: `New ${rating}-star review for "${c.auctionTitle}"`,
        template: 'review-received',
        templateData: { ...base, rating, sellerUrl: `${env.app.url}${sellerPath}` },
      };
    }
    case 'question-asked': {
      const question = clip(c.data.question);
      return {
        title: 'New question on your lot',
        body: `A bidder asked about "${c.auctionTitle}": ${question}`,
        url: auctionPath,
        subject: `New question on "${c.auctionTitle}"`,
        template: 'question-asked',
        templateData: { ...base, question },
      };
    }
    case 'question-answered': {
      const answer = clip(c.data.answer);
      return {
        title: 'Your question was answered',
        body: `The seller answered your question on "${c.auctionTitle}": ${answer}`,
        url: auctionPath,
        subject: `Your question on "${c.auctionTitle}" was answered`,
        template: 'question-answered',
        templateData: { ...base, answer },
      };
    }
    case 'saved-search-match': {
      const searchName = str(c.data.searchName).trim();
      return {
        title: 'New listing matches your saved search',
        body: searchName
          ? `"${c.auctionTitle}" matches your saved search "${searchName}".`
          : `"${c.auctionTitle}" matches one of your saved searches.`,
        url: auctionPath,
        subject: `New listing: "${c.auctionTitle}"`,
        template: 'saved-search-match',
        templateData: { ...base, searchName },
      };
    }
    case 'followed-seller-listed': {
      const sellerName = clip(c.data.sellerName, 80) || 'A seller you follow';
      return {
        title: 'New listing from a seller you follow',
        body: `${sellerName} listed "${c.auctionTitle}".`,
        url: auctionPath,
        subject: `${sellerName} listed "${c.auctionTitle}"`,
        template: 'followed-seller-listed',
        templateData: { ...base, sellerName },
      };
    }
    case 'sale-receipt':
    case 'sale-paid':
    case 'sale-shipped':
    case 'sale-released':
    case 'sale-disputed':
    case 'sale-refunded':
    case 'sale-cancelled':
      return saleContent({ ...c, type: c.type }, base);
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
    case 'report-filed': {
      const targetType = str(c.data.targetType).toLowerCase();
      const reason = str(c.data.reason).toLowerCase();
      const targetLabel = clip(c.data.targetLabel, 120);
      return {
        title: 'New report filed',
        body: `A ${targetType || 'listing'} was reported (${reason || 'other'}): ${targetLabel}`,
        url: '/admin/reports',
        subject: `New ${targetType || 'content'} report on NobleBid`,
        template: 'report-filed',
        templateData: { name: c.memberName, targetType, reason, targetLabel, reportsUrl: `${env.app.url}/admin/reports` },
      };
    }
    case 'deposit-held': {
      const amount = formatInr(num(c.data.amountPaise));
      return {
        title: 'Deposit received',
        body: `Your refundable deposit of ${amount} for "${c.auctionTitle}" is held. You can bid now.`,
        url: auctionPath,
        subject: `Deposit of ${amount} received for "${c.auctionTitle}"`,
        template: 'deposit-held',
        templateData: { ...base, amount },
      };
    }
    case 'deposit-refunded': {
      const amount = formatInr(num(c.data.amountPaise));
      return {
        title: 'Deposit refunded',
        body: `Your deposit of ${amount} for "${c.auctionTitle}" was refunded to your original payment method.`,
        url: auctionPath,
        subject: `Deposit of ${amount} refunded for "${c.auctionTitle}"`,
        template: 'deposit-refunded',
        templateData: { ...base, amount },
      };
    }
    case 'deposit-forfeited': {
      const amount = formatInr(num(c.data.amountPaise));
      return {
        title: 'Deposit forfeited',
        body: `You won "${c.auctionTitle}" but did not pay in time, so your deposit of ${amount} was forfeited.`,
        url: auctionPath,
        subject: `Deposit of ${amount} forfeited for "${c.auctionTitle}"`,
        template: 'deposit-forfeited',
        templateData: { ...base, amount },
      };
    }
    case 'strike-issued': {
      const strikeCount = num(c.data.strikeCount);
      const depositsRequired = c.data.depositsRequired === true;
      const expires = dateText(c.data.expiresAt);
      const purchasesPath = '/purchases';
      return {
        title: depositsRequired ? 'Second strike: deposits now required' : 'Strike issued',
        body: depositsRequired
          ? `You did not pay for "${c.auctionTitle}" in time. This is strike ${strikeCount}: a refundable deposit is now required on every bid. A third strike suspends your account.`
          : `You did not pay for "${c.auctionTitle}" in time, so your account received a strike. Three active strikes suspend your account.`,
        url: purchasesPath,
        subject: depositsRequired ? 'Strike 2: deposits are now required on every bid' : 'You received a strike for an unpaid auction',
        template: 'strike-issued',
        templateData: { ...base, strikeCount, depositsRequired, expires, purchasesUrl: `${env.app.url}${purchasesPath}` },
      };
    }
    case 'account-suspended':
      return {
        title: 'Account suspended',
        body: `Your account was suspended after ${num(c.data.strikeCount) || 3} strikes for unpaid auctions. Contact support if you think this is a mistake.`,
        url: '/contact',
        subject: 'Your NobleBid account was suspended',
        template: 'account-suspended',
        templateData: { ...base, strikeCount: num(c.data.strikeCount) || 3 },
      };
    case 'second-chance-offer': {
      const amount = formatInr(num(c.data.amountPaise));
      const offerPath = `/purchases/offers/${str(c.data.offerId)}`;
      const expires = dateText(c.data.expiresAt);
      return {
        title: 'Second chance to buy',
        body: `The winner of "${c.auctionTitle}" did not pay. The seller offers it to you for ${amount}${expires ? ` (offer ends ${expires})` : ''}.`,
        url: offerPath,
        subject: `Second chance: "${c.auctionTitle}" for ${amount}`,
        template: 'second-chance-offer',
        templateData: { ...base, amount, expires, offerUrl: `${env.app.url}${offerPath}` },
      };
    }
    case 'second-chance-accepted': {
      const amount = formatInr(num(c.data.amountPaise));
      const salePath = `/sell/sales/${str(c.data.saleId)}`;
      return {
        title: 'Second-chance offer accepted',
        body: `The bidder accepted your offer of ${amount} for "${c.auctionTitle}". They have 3 days to pay.`,
        url: salePath,
        subject: `Second-chance offer accepted for "${c.auctionTitle}"`,
        template: 'second-chance-accepted',
        templateData: { ...base, amount, saleUrl: `${env.app.url}${salePath}` },
      };
    }
    case 'second-chance-declined': {
      const salePath = `/sell/sales/${str(c.data.saleId)}`;
      return {
        title: 'Second-chance offer declined',
        body: `The bidder declined your second-chance offer for "${c.auctionTitle}".`,
        url: salePath,
        subject: `Second-chance offer declined for "${c.auctionTitle}"`,
        template: 'second-chance-declined',
        templateData: { ...base, saleUrl: `${env.app.url}${salePath}` },
      };
    }
    case 'shill-flag': {
      const score = num(c.data.score);
      const reasons = Array.isArray(c.data.reasons) ? c.data.reasons.filter((r): r is string => typeof r === 'string') : [];
      return {
        title: 'Possible shill bidding',
        body: `Bidding on "${c.auctionTitle}" was flagged for review (score ${score}${reasons.length ? `: ${reasons.join(', ')}` : ''}).`,
        url: '/admin/risk',
        subject: `Shill-bid flag on "${c.auctionTitle}"`,
        template: 'shill-flag',
        templateData: { ...base, score, reasons: reasons.join(', '), riskUrl: `${env.app.url}/admin/risk` },
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

type SaleType = 'sale-receipt' | 'sale-paid' | 'sale-shipped' | 'sale-released' | 'sale-disputed' | 'sale-refunded' | 'sale-cancelled';

/** Pure: copy for the checkout (sale-*) notifications. `data.role` picks the link (BUYER / SELLER / ADMIN). */
function saleContent(c: ContentCtx & { type: SaleType }, base: { name: string; auctionTitle: string; auctionUrl: string }): Content {
  const saleId = str(c.data.saleId);
  const role = str(c.data.role);
  const path = role === 'ADMIN' ? '/admin/sales' : role === 'SELLER' ? `/sell/sales/${saleId}` : `/purchases/${saleId}`;
  const amount = formatInr(num(c.data.amountPaise));
  const payout = formatInr(num(c.data.payoutPaise));
  const courier = str(c.data.courier).trim();
  const trackingNo = str(c.data.trackingNo).trim();
  const shipping = [courier && `Courier: ${courier}.`, trackingNo && `Tracking no: ${trackingNo}.`].filter(Boolean).join(' ');
  const reason = clip(c.data.reason, 300);
  const t = c.auctionTitle;
  const copy: Record<SaleType, { title: string; body: string; subject: string }> = {
    'sale-receipt': {
      title: 'Payment received',
      body: `We received your payment of ${amount} for "${t}". It is held safely until you confirm delivery.`,
      subject: `Payment of ${amount} received for "${t}"`,
    },
    'sale-paid': {
      title: 'Buyer paid - ship the item',
      body: `The buyer paid ${amount} for "${t}". Please ship the item and mark it as shipped.`,
      subject: `Buyer paid for "${t}" - please ship`,
    },
    'sale-shipped': {
      title: 'Your item has shipped',
      body: `The seller shipped "${t}".${shipping ? ` ${shipping}` : ''} Confirm delivery when it arrives.`,
      subject: `"${t}" has shipped`,
    },
    'sale-released': {
      title: 'Payout released',
      body: `Your payout of ${payout} for "${t}" was released to your linked account.`,
      subject: `Payout of ${payout} released for "${t}"`,
    },
    'sale-disputed': {
      title: 'Sale in dispute',
      body: `A dispute was opened for "${t}".${reason ? ` Reason: ${reason}` : ''} The funds stay on hold.`,
      subject: `Dispute opened for "${t}"`,
    },
    'sale-refunded': {
      title: 'Payment refunded',
      body: `The payment of ${amount} for "${t}" was refunded to the buyer.`,
      subject: `Payment refunded for "${t}"`,
    },
    'sale-cancelled': {
      title: 'Sale cancelled',
      body: `The sale of "${t}" was cancelled because it was not paid in time.`,
      subject: `Sale cancelled for "${t}"`,
    },
  };
  return {
    ...copy[c.type],
    url: path,
    template: c.type,
    templateData: { ...base, amount, payout, shipping, reason, saleUrl: `${env.app.url}${path}` },
  };
}
