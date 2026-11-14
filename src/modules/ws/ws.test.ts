import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  wsTicket: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  wsConnection: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  auction: { findFirst: vi.fn(), findUnique: vi.fn() },
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/core/config/env', () => ({ env: { port: 4000, ws: { apiEndpoint: '', publicUrl: '' } } }));

import {
  getWsUrl,
  handleConnect,
  handleDefault,
  issueTicket,
  parseClientMessage,
  pushToAuctionRoom,
  pushToMember,
} from './ws.service';
import { publishAuctionEvent } from '@/modules/auctions/auction-events';
import { buildLocalEvent } from './ws.local';
import {
  registerLocalSocket,
  setLocalServerActive,
  unregisterLocalSocket,
  type LocalSocket,
} from './ws.transport';

function sock(open = true) {
  const sent: string[] = [];
  const s: LocalSocket & { sent: string[] } = {
    readyState: open ? 1 : 3,
    send: (d: string) => void sent.push(d),
    close: vi.fn(),
    sent,
  };
  return s;
}
const frames = (s: { sent: string[] }) => s.sent.map((x) => JSON.parse(x));
const ev = (body?: string, connectionId = 'c1') => buildLocalEvent('MESSAGE', connectionId, { body });

beforeEach(() => {
  vi.clearAllMocks();
  setLocalServerActive(false);
  for (const id of ['c1', 'c2', 'c3', 'c4']) unregisterLocalSocket(id);
  db.wsConnection.deleteMany.mockResolvedValue({ count: 0 });
  db.wsConnection.updateMany.mockResolvedValue({ count: 1 });
});

describe('tickets', () => {
  it('issues a 60s ticket (guest = null member) and wsUrl', async () => {
    db.wsTicket.create.mockImplementation(async ({ data }) => ({ id: 't1', ...data }));
    const t = await issueTicket(null);
    expect(t.ticket).toBe('t1');
    expect(t.wsUrl).toBeNull();
    const data = db.wsTicket.create.mock.calls[0][0].data;
    expect(data.memberId).toBeNull();
    expect(data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    setLocalServerActive(true);
    expect(getWsUrl()).toBe('ws://localhost:4000/ws');
  });

  it('connect: consumes a valid ticket once', async () => {
    db.wsTicket.findUnique.mockResolvedValue({ id: 't1', memberId: 'm1', usedAt: null, expiresAt: new Date(Date.now() + 5000) });
    db.wsTicket.updateMany.mockResolvedValue({ count: 1 });
    const r = await handleConnect(buildLocalEvent('CONNECT', 'c1', { query: new URLSearchParams('ticket=t1') }));
    expect(r.statusCode).toBe(200);
    expect(db.wsConnection.create).toHaveBeenCalledWith({ data: { id: 'c1', memberId: 'm1' } });
  });

  it('connect: rejects used, expired, missing, unknown and race-lost tickets with 401', async () => {
    const q = (t?: string) => buildLocalEvent('CONNECT', 'c1', { query: new URLSearchParams(t ? `ticket=${t}` : '') });
    expect((await handleConnect(q())).statusCode).toBe(401);
    db.wsTicket.findUnique.mockResolvedValueOnce(null);
    expect((await handleConnect(q('x'))).statusCode).toBe(401);
    db.wsTicket.findUnique.mockResolvedValueOnce({ id: 't', memberId: null, usedAt: new Date(), expiresAt: new Date(Date.now() + 5000) });
    expect((await handleConnect(q('t'))).statusCode).toBe(401);
    db.wsTicket.findUnique.mockResolvedValueOnce({ id: 't', memberId: null, usedAt: null, expiresAt: new Date(Date.now() - 1) });
    expect((await handleConnect(q('t'))).statusCode).toBe(401);
    db.wsTicket.findUnique.mockResolvedValueOnce({ id: 't', memberId: null, usedAt: null, expiresAt: new Date(Date.now() + 5000) });
    db.wsTicket.updateMany.mockResolvedValueOnce({ count: 0 });
    expect((await handleConnect(q('t'))).statusCode).toBe(401);
    expect(db.wsConnection.create).not.toHaveBeenCalled();
  });
});

describe('messages', () => {
  it('parses valid and rejects invalid frames', () => {
    expect(parseClientMessage('{"action":"ping"}')).toEqual({ action: 'ping' });
    expect(parseClientMessage('{"action":"unsubscribe"}')).toEqual({ action: 'unsubscribe' });
    expect(parseClientMessage('{"action":"subscribe","auctionId":"a1"}')).toEqual({ action: 'subscribe', auctionId: 'a1' });
    for (const bad of ['', 'nope', '[]', '{"action":"subscribe"}', '{"action":"subscribe","auctionId":5}', '{"action":"x"}', 'null', undefined]) {
      expect(parseClientMessage(bad as string | undefined)).toBeNull();
    }
  });

  it('ping -> pong; garbage -> BAD_MESSAGE', async () => {
    const s = sock();
    registerLocalSocket('c1', s);
    await handleDefault(ev('{"action":"ping"}'));
    await handleDefault(ev('garbage'));
    expect(frames(s)).toEqual([{ type: 'pong' }, { type: 'error', code: 'BAD_MESSAGE' }]);
  });

  it('subscribe validates the auction exists', async () => {
    const s = sock();
    registerLocalSocket('c1', s);
    db.auction.findFirst.mockResolvedValueOnce({ id: 'a1' });
    await handleDefault(ev('{"action":"subscribe","auctionId":"a1"}'));
    expect(db.wsConnection.updateMany).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { auctionId: 'a1' } });
    db.auction.findFirst.mockResolvedValueOnce(null);
    await handleDefault(ev('{"action":"subscribe","auctionId":"zzz"}'));
    expect(frames(s)).toEqual([{ type: 'error', code: 'BAD_MESSAGE' }]);
    await handleDefault(ev('{"action":"unsubscribe"}'));
    expect(db.wsConnection.updateMany).toHaveBeenLastCalledWith({ where: { id: 'c1' }, data: { auctionId: null } });
  });
});

describe('fan-out', () => {
  it('room broadcast delivers and deletes gone connections', async () => {
    const live = sock();
    registerLocalSocket('c1', live);
    registerLocalSocket('c2', sock(false)); // closed socket
    // c3 never registered
    db.wsConnection.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
    await pushToAuctionRoom('a1', { type: 'auction.extended', auctionId: 'a1', endTime: 'x' });
    expect(frames(live)).toHaveLength(1);
    expect(db.wsConnection.findMany).toHaveBeenCalledWith({ where: { auctionId: 'a1' }, select: { id: true } });
    expect(db.wsConnection.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c2', 'c3'] } } });
  });

  it('member push goes to every connection of that member only', async () => {
    const a = sock();
    const b = sock();
    registerLocalSocket('c1', a);
    registerLocalSocket('c2', b);
    db.wsConnection.findMany.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }]);
    await pushToMember('m1', { type: 'notification.new', notificationId: 'n1' });
    expect(db.wsConnection.findMany).toHaveBeenCalledWith({ where: { memberId: 'm1' }, select: { id: true } });
    expect(frames(a)).toEqual(frames(b));
    expect(frames(a)).toEqual([{ type: 'notification.new', notificationId: 'n1' }]);
  });

  it('push helpers never throw on DB failure', async () => {
    db.wsConnection.findMany.mockRejectedValue(new Error('db down'));
    await expect(pushToMember('m1', { type: 'x' })).resolves.toBeUndefined();
    await expect(pushToAuctionRoom('a1', { type: 'x' })).resolves.toBeUndefined();
  });
});

describe('publishAuctionEvent', () => {
  const bid = {
    type: 'bid.placed' as const,
    auctionId: 'a1',
    currentBidPaise: 500,
    bidCount: 2,
    endTime: '2026-01-01T00:00:00.000Z',
    highestBidderId: 'm2',
    previousHighestBidderId: 'm1',
    bid: { id: 'b1', amountPaise: 500, createdAt: 'x', bidderLabel: 'Bidder 1' },
  };

  it('bid.placed: room frame without previousHighestBidderId + outbid to previous bidder', async () => {
    db.auction.findUnique.mockResolvedValue({ title: 'Watch' });
    db.wsConnection.findMany.mockImplementation(async ({ where }) =>
      where.auctionId ? [{ id: 'c1' }] : where.memberId === 'm1' ? [{ id: 'c2' }] : [],
    );
    const room = sock();
    const prev = sock();
    registerLocalSocket('c1', room);
    registerLocalSocket('c2', prev);
    await publishAuctionEvent(bid);
    const [f] = frames(room);
    expect(f.type).toBe('bid.placed');
    expect(f.previousHighestBidderId).toBeUndefined();
    expect(frames(prev)).toEqual([{ type: 'bid.outbid', auctionId: 'a1', title: 'Watch', currentBidPaise: 500 }]);
  });

  it('auction.ended: room + auction.won to winner', async () => {
    db.auction.findUnique.mockResolvedValue({ title: 'Watch' });
    db.wsConnection.findMany.mockImplementation(async ({ where }) =>
      where.auctionId ? [{ id: 'c1' }] : where.memberId === 'm9' ? [{ id: 'c2' }] : [],
    );
    const room = sock();
    const winner = sock();
    registerLocalSocket('c1', room);
    registerLocalSocket('c2', winner);
    await publishAuctionEvent({ type: 'auction.ended', auctionId: 'a1', winnerId: 'm9', finalBidPaise: 900, bidCount: 3, endedAt: 'e' });
    expect(frames(room)[0].type).toBe('auction.ended');
    expect(frames(winner)).toEqual([{ type: 'auction.won', auctionId: 'a1', title: 'Watch', finalBidPaise: 900 }]);
  });

  it('never throws', async () => {
    db.wsConnection.findMany.mockRejectedValue(new Error('boom'));
    db.auction.findUnique.mockRejectedValue(new Error('boom'));
    await expect(publishAuctionEvent(bid)).resolves.toBeUndefined();
    await expect(publishAuctionEvent({ type: 'auction.extended', auctionId: 'a1', endTime: 'x' })).resolves.toBeUndefined();
  });
});

describe('local adapter', () => {
  it('builds API-Gateway-shaped events', () => {
    expect(buildLocalEvent('CONNECT', 'id1', { query: new URLSearchParams('ticket=abc') })).toEqual({
      requestContext: { connectionId: 'id1', eventType: 'CONNECT' },
      queryStringParameters: { ticket: 'abc' },
      body: null,
    });
    expect(buildLocalEvent('MESSAGE', 'id1', { body: '{}' })).toMatchObject({ body: '{}', queryStringParameters: null });
  });
});
