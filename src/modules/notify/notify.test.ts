import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  notification: { findUnique: vi.fn(), create: vi.fn() },
  member: { findUnique: vi.fn() },
  auction: { findUnique: vi.fn() },
  notificationPreference: { findUnique: vi.fn() },
}));
const wa = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/core/config/env', () => ({
  env: {
    app: { url: 'https://app.test', websiteUrl: 'https://www.test' },
    email: { fromName: 'NobleBid', logoUrl: '' },
    whatsapp: { templates: { outbid: 'nb_outbid', endingSoon: 'nb_ending_soon', auctionWon: 'nb_auction_won', salePaymentDue: 'nb_sale_payment_due' } },
  },
}));
vi.mock('@/providers/whatsapp', () => ({ whatsappProvider: { sendTemplate: wa } }));
vi.mock('@/providers/email', () => ({ emailProvider: { send } }));
const wsPush = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/modules/ws/ws.service', () => ({ pushToMember: wsPush }));
vi.mock('@/modules/push/push.service', () => ({ sendPushToMember: push }));

import { processNotification } from './notify.service';
import { processSqsBatch } from './notify.worker';
import { buildContent, formatInr } from './notify.content';
import { NOTIFY_TYPES, type NotifyMessage } from './notify.types';
// Real renderer for the template smoke test (the provider index above is mocked).
import { renderEmail } from '@/providers/email/render';

const msg: NotifyMessage = {
  type: 'outbid',
  memberId: 'm1',
  auctionId: 'a1',
  data: { newBidPaise: 150_000, yourBidPaise: 140_000 },
  dedupeKey: 'outbid:b1:m1',
};

beforeEach(() => {
  vi.clearAllMocks();
  db.notification.findUnique.mockResolvedValue(null);
  db.notification.create.mockResolvedValue({ id: 'n1' });
  db.member.findUnique.mockResolvedValue({ id: 'm1', name: 'Ramesh', email: 'r@example.com', isActive: true });
  db.auction.findUnique.mockResolvedValue({ title: 'Vintage Watch', seller: null, winner: null, highestBidder: null });
  db.notificationPreference.findUnique.mockResolvedValue(null);
  wa.mockResolvedValue(undefined);
  send.mockResolvedValue(undefined);
});

describe('processNotification', () => {
  it('sends email, stores the row, pushes', async () => {
    expect(await processNotification(msg)).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(wsPush).toHaveBeenCalledWith('m1', { type: 'notification.new', notificationId: 'n1' });
    expect(db.notification.create.mock.calls[0][0].data).toMatchObject({
      memberId: 'm1',
      type: 'outbid',
      dedupeKey: 'outbid:b1:m1',
      url: '/auctions/a1',
    });
    expect(push).toHaveBeenCalledWith('m1', expect.objectContaining({ type: 'outbid', url: '/auctions/a1' }));
  });

  it('existing dedupeKey -> nothing is sent or stored', async () => {
    db.notification.findUnique.mockResolvedValue({ id: 'n0' });
    expect(await processNotification(msg)).toBe('duplicate');
    expect(send).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('a unique-violation race on insert is a duplicate and does not push', async () => {
    db.notification.create.mockRejectedValue({ code: 'P2002' });
    expect(await processNotification(msg)).toBe('duplicate');
    expect(push).not.toHaveBeenCalled();
  });

  it('inactive member is skipped entirely', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1', name: 'R', email: 'r@example.com', isActive: false });
    expect(await processNotification(msg)).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it('email failure: inline still stores + pushes; worker mode rethrows before storing', async () => {
    send.mockRejectedValue(new Error('ses down'));
    expect(await processNotification(msg)).toBe('sent');
    expect(db.notification.create).toHaveBeenCalledOnce();

    db.notification.create.mockClear();
    await expect(processNotification(msg, { rethrowEmailErrors: true })).rejects.toThrow('ses down');
    expect(db.notification.create).not.toHaveBeenCalled();
  });
});

describe('processSqsBatch', () => {
  it('reports only the failed records', async () => {
    db.member.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      name: 'Ramesh',
      email: `${where.id}@example.com`,
      isActive: true,
    }));
    send.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'bad@example.com') throw new Error('boom');
    });
    const rec = (messageId: string, memberId: string) => ({
      messageId,
      body: JSON.stringify({ ...msg, memberId, dedupeKey: `outbid:${messageId}:${memberId}` }),
    });
    const res = await processSqsBatch({
      Records: [rec('ok1', 'm1'), rec('bad', 'bad'), { messageId: 'poison', body: '{not json' }, rec('ok2', 'm2')],
    });
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }, { itemIdentifier: 'poison' }] });
    expect(db.notification.create).toHaveBeenCalledTimes(2);
  });
});

describe('suspended members', () => {
  it('account-suspended is still delivered to an inactive member; other types are skipped', async () => {
    db.member.findUnique.mockResolvedValue({ id: 'm1', name: 'R', email: 'r@example.com', isActive: false });
    db.notification.findUnique.mockResolvedValue(null);
    db.notification.create.mockResolvedValue({ id: 'n1' });
    expect(await processNotification({ type: 'account-suspended', memberId: 'm1', data: { strikeCount: 3 }, dedupeKey: 'account-suspended:st1' })).toBe('sent');
    expect(await processNotification({ ...msg, memberId: 'm1' })).toBe('skipped');
  });
});

describe('trust 2 copy', () => {
  const ctx = { auctionId: 'a1', auctionTitle: 'Vintage Watch', memberName: 'Ramesh' };
  it('strike-issued: warning vs deposits-required', () => {
    const warn = buildContent({ ...ctx, type: 'strike-issued', data: { strikeCount: 1, depositsRequired: false } });
    expect(warn.body).toMatch(/strike/);
    expect(warn.body).not.toMatch(/deposit is now required/);
    const second = buildContent({ ...ctx, type: 'strike-issued', data: { strikeCount: 2, depositsRequired: true } });
    expect(second.body).toMatch(/deposit is now required on every bid/);
  });
  it('second-chance-offer links to the offer page and shows the amount', () => {
    const c = buildContent({ ...ctx, type: 'second-chance-offer', data: { offerId: 'o1', amountPaise: 9_500_000 } });
    expect(c.url).toBe('/purchases/offers/o1');
    expect(c.body).toMatch(/95,000/);
  });
  it('shill-flag goes to the admin risk page', () => {
    expect(buildContent({ ...ctx, type: 'shill-flag', data: { score: 70, reasons: ['SHARED_DEVICE'] } })).toMatchObject({ url: '/admin/risk', template: 'shill-flag' });
  });
  it('deposit-* types link to the auction', () => {
    for (const type of ['deposit-held', 'deposit-refunded', 'deposit-forfeited'] as const) {
      expect(buildContent({ ...ctx, type, data: { amountPaise: 100_000 } })).toMatchObject({ url: '/auctions/a1', template: type });
    }
  });
});

describe('formatInr + templates', () => {
  it('formats INR with Indian grouping', () => {
    expect(formatInr(12_345_600)).toMatch(/1,23,456/);
    expect(formatInr(123_450)).toMatch(/1,234\.50/);
  });

  it('auction-unsold copy says the reserve was not met when flagged; reserve-not-met renders for the bidder', async () => {
    const ctx = { auctionId: 'a1', auctionTitle: 'Vintage Watch', memberName: 'Ramesh' };
    const plain = buildContent({ ...ctx, type: 'auction-unsold', data: {} });
    const reserve = buildContent({ ...ctx, type: 'auction-unsold', data: { reserveNotMet: true } });
    expect(plain.body).toMatch(/no bids/);
    expect(reserve.body).toMatch(/reserve/);
    expect(reserve.templateData).toMatchObject({ reserveNotMet: true });
    const html = await renderEmail('auction-unsold', { ...reserve.templateData, auctionUrl: 'https://app.test/auctions/a1' });
    expect(html.text).toMatch(/reserve/);
    expect(buildContent({ ...ctx, type: 'reserve-not-met', data: {} })).toMatchObject({ template: 'reserve-not-met' });
  });

  it('builds content for the review / question / saved-search types', () => {
    const ctx = { auctionId: 'a1', auctionTitle: 'Vintage Watch', memberName: 'Ramesh' };
    expect(buildContent({ ...ctx, type: 'review-received', data: { rating: 4, sellerId: 's1' } })).toMatchObject({
      template: 'review-received',
      url: '/sellers/s1',
      title: 'New review received',
    });
    const asked = buildContent({ ...ctx, type: 'question-asked', data: { question: 'Works?' } });
    expect(asked).toMatchObject({ template: 'question-asked', url: '/auctions/a1' });
    expect(asked.body).toContain('Works?');
    const answered = buildContent({ ...ctx, type: 'question-answered', data: { answer: 'Yes' } });
    expect(answered).toMatchObject({ template: 'question-answered', url: '/auctions/a1' });
    expect(answered.body).toContain('Yes');
    const named = buildContent({ ...ctx, type: 'saved-search-match', data: { searchName: 'Watches' } });
    expect(named).toMatchObject({ template: 'saved-search-match', url: '/auctions/a1' });
    expect(named.body).toContain('"Watches"');
    expect(buildContent({ ...ctx, type: 'saved-search-match', data: { searchName: '' } }).body).toContain('one of your saved searches');
  });

  it('escapes user text in the question email', async () => {
    const out = await renderEmail('question-asked', {
      name: 'R',
      auctionTitle: 'T',
      auctionUrl: 'https://app.test/auctions/a1',
      question: '<script>alert(1)</script>',
    });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it.each(NOTIFY_TYPES)('renders %s (html + text)', async (type) => {
    const person = { name: 'Asha', email: 'a@example.com', phone: null };
    const out = await renderEmail(type, {
      name: 'Ramesh',
      auctionTitle: 'Vintage Watch',
      auctionUrl: 'https://app.test/auctions/a1',
      newBid: 'Rs 1,500',
      yourBid: 'Rs 1,400',
      finalBid: 'Rs 2,000',
      commission: 'Rs 100',
      endsAt: '6:30 pm IST',
      dueDate: '21 Nov 2026',
      commissionUrl: 'https://app.test/sell/commissions',
      seller: person,
      winner: person,
      rating: 5,
      sellerUrl: 'https://app.test/sellers/s1',
      question: 'Does it come with the box?',
      answer: 'Yes, with the original box.',
      searchName: 'Cheap watches',
      sellerName: 'Asha Antiques',
      checkout: false,
      payBy: '18 Nov 2026',
      saleUrl: 'https://app.test/purchases/s1',
      amount: 'Rs 2,000',
      payout: 'Rs 1,900',
      shipping: 'Courier: BlueDart.',
      reason: 'Not as described',
      targetType: 'auction',
      targetLabel: 'Vintage Watch',
      reportsUrl: 'https://app.test/admin/reports',
      strikeCount: 2,
      depositsRequired: true,
      expires: '15 Nov 2027',
      purchasesUrl: 'https://app.test/purchases',
      supportUrl: 'https://app.test/contact',
      offerUrl: 'https://app.test/purchases/offers/o1',
      score: 70,
      reasons: 'SHARED_DEVICE',
      riskUrl: 'https://app.test/admin/risk',
      until: '20 Nov 2026',
      reward: 'Rs 100',
      creditsUrl: 'https://app.test/profile?tab=referrals',
      invoiceNo: 'NB/2026-27/000001',
      invoicesUrl: 'https://app.test/profile?tab=invoices',
    });
    if (type !== 'referral-rewarded') {
      expect(out.html).toContain('Vintage Watch');
      expect(out.text).toContain('Vintage Watch');
    }
    expect(out.text).toContain('Support: https://www.test/contact');
    expect(out.html).toContain('https://www.test/contact');
    expect(out.html).not.toContain('https://app.test/contact');
    if (type === 'auction-won') expect(out.text).toContain('Seller: Asha, a@example.com, phone not provided');
  });
});

describe('channel preferences', () => {
  const waMember = { id: 'm1', name: 'Ramesh', email: 'r@example.com', isActive: true, phone: '9876543210', phoneVerifiedAt: new Date(), whatsappOptInAt: new Date() };
  const waMsg: NotifyMessage = { ...msg, type: 'outbid' };
  beforeEach(() => {
    db.member.findUnique.mockResolvedValue(waMember);
  });

  it('defaults (no row): email + push, no WhatsApp', async () => {
    await processNotification(waMsg);
    expect(send).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    expect(wa).not.toHaveBeenCalled();
  });

  it('email off skips the email but still stores the inbox row and pushes', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: false, push: true, whatsapp: false });
    expect(await processNotification(waMsg)).toBe('sent');
    expect(send).not.toHaveBeenCalled();
    expect(db.notification.create).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
  });

  it('push off skips Web Push only', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: false, whatsapp: false });
    await processNotification(waMsg);
    expect(send).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(wsPush).toHaveBeenCalledOnce();
  });

  it('mandatory email types ignore email = false', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: false, push: true, whatsapp: false });
    await processNotification({ ...msg, type: 'auction-won', data: { finalBidPaise: 100 } });
    expect(send).toHaveBeenCalledOnce();
  });

  it('WhatsApp on + opted in + verified phone + capable: sends the template with title, INR amount and link', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: true, whatsapp: true });
    db.auction.findUnique.mockResolvedValue({ title: 'T'.repeat(80), seller: null, winner: null, highestBidder: null });
    await processNotification(waMsg);
    expect(wa).toHaveBeenCalledWith({
      to: '+919876543210',
      template: 'nb_outbid',
      language: 'en',
      params: ['T'.repeat(59) + '...', '₹1,500', '/auctions/a1'],
    });
  });

  it('auction-won in checkout mode uses the payment-due template', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: true, whatsapp: true });
    await processNotification({ ...msg, type: 'auction-won', data: { saleId: 's1', finalBidPaise: 250_000 } });
    expect(wa.mock.calls[0][0]).toMatchObject({ template: 'nb_sale_payment_due', params: ['Vintage Watch', '₹2,500', '/purchases/s1'] });
  });

  it('ending-soon takes the amount from the current bid', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: true, whatsapp: true });
    db.auction.findUnique.mockResolvedValue({ title: 'W', currentBidPaise: 500_000n, startingBidPaise: 1n, seller: null, winner: null, highestBidder: null });
    await processNotification({ ...msg, type: 'ending-soon', data: {} });
    expect(wa.mock.calls[0][0]).toMatchObject({ template: 'nb_ending_soon', params: ['W', '₹5,000', '/auctions/a1'] });
  });

  it.each([
    ['not opted in', { whatsappOptInAt: null }, 'outbid'],
    ['phone not verified', { phoneVerifiedAt: null }, 'outbid'],
    ['type not capable', {}, 'review-received'],
  ])('no WhatsApp when %s', async (_l, over, type) => {
    db.member.findUnique.mockResolvedValue({ ...waMember, ...over });
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: true, whatsapp: true });
    await processNotification({ ...msg, type: type as NotifyMessage['type'] });
    expect(wa).not.toHaveBeenCalled();
  });

  it('no WhatsApp when the preference is off', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: true, whatsapp: false });
    await processNotification(waMsg);
    expect(wa).not.toHaveBeenCalled();
  });

  it('a WhatsApp failure never fails the message, even in worker mode', async () => {
    db.notificationPreference.findUnique.mockResolvedValue({ email: true, push: true, whatsapp: true });
    wa.mockRejectedValue(new Error('meta down'));
    expect(await processNotification(waMsg, { rethrowEmailErrors: true })).toBe('sent');
    expect(db.notification.create).toHaveBeenCalledOnce();
  });
});
