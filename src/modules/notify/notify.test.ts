import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  notification: { findUnique: vi.fn(), create: vi.fn() },
  member: { findUnique: vi.fn() },
  auction: { findUnique: vi.fn() },
}));
const send = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/core/config/env', () => ({
  env: { app: { url: 'https://app.test' }, email: { fromName: 'NobleBid', logoUrl: '' } },
}));
vi.mock('@/providers/email', () => ({ emailProvider: { send } }));
const wsPush = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/modules/ws/ws.service', () => ({ pushToMember: wsPush }));
vi.mock('@/modules/push/push.service', () => ({ sendPushToMember: push }));

import { processNotification } from './notify.service';
import { processSqsBatch } from './notify.worker';
import { formatInr } from './notify.content';
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

describe('formatInr + templates', () => {
  it('formats INR with Indian grouping', () => {
    expect(formatInr(12_345_600)).toMatch(/1,23,456/);
    expect(formatInr(123_450)).toMatch(/1,234\.50/);
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
    });
    expect(out.html).toContain('Vintage Watch');
    expect(out.text).toContain('Vintage Watch');
    if (type === 'auction-won') expect(out.text).toContain('Seller: Asha, a@example.com, phone not provided');
  });
});
