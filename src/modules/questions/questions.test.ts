import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  auction: { findUnique: vi.fn() },
  auctionQuestion: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('@/modules/auctions/auctions.service', async () => {
  const { AppError } = await import('@/core/errors/AppError');
  return { auctionNotFound: () => new AppError(404, 'AUCTION_NOT_FOUND', 'Auction not found') };
});

import { askQuestion, answerQuestion, hideQuestion, listQuestions } from './questions.service';
import { toQuestionDTO, visibilityWhere } from './questions.rules';

const H = 3_600_000;
const now = new Date('2026-11-15T10:00:00Z');
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );
const auction = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  sellerId: 's1',
  status: 'LIVE',
  deletedAt: null,
  startTime: new Date(now.getTime() - H),
  endTime: new Date(now.getTime() + H),
  ...over,
});
const qRow = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  auctionId: 'a1',
  askerId: 'b1',
  question: 'Is it working?',
  answer: null,
  answeredAt: null,
  createdAt: now,
  asker: { name: 'Bimal' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.auction.findUnique.mockResolvedValue(auction());
  db.auctionQuestion.findMany.mockResolvedValue([]);
});

describe('visibility matrix', () => {
  it('guest: answered only', () => {
    expect(visibilityWhere(undefined, 's1')).toEqual({ OR: [{ answer: { not: null } }] });
  });
  it('asker: answered plus their own', () => {
    expect(visibilityWhere({ sub: 'b1', role: 'MEMBER' }, 's1')).toEqual({ OR: [{ answer: { not: null } }, { askerId: 'b1' }] });
  });
  it('seller and SUPER_ADMIN: everything', () => {
    expect(visibilityWhere({ sub: 's1', role: 'MEMBER' }, 's1')).toEqual({});
    expect(visibilityWhere({ sub: 'adm', role: 'SUPER_ADMIN' }, 's1')).toEqual({});
  });
  it('listQuestions never loads hidden rows, newest first, max 100', async () => {
    await listQuestions('a1', undefined, now);
    const arg = db.auctionQuestion.findMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({ auctionId: 'a1', hiddenAt: null });
    expect(arg.take).toBe(100);
    expect(arg.orderBy[0]).toEqual({ createdAt: 'desc' });
  });
  it('404 for unknown auctions and for cancelled ones unless privileged', async () => {
    db.auction.findUnique.mockResolvedValue(null);
    expect(await code(listQuestions('a1', undefined, now))).toBe('404:AUCTION_NOT_FOUND');
    db.auction.findUnique.mockResolvedValue(auction({ status: 'CANCELLED' }));
    expect(await code(listQuestions('a1', undefined, now))).toBe('404:AUCTION_NOT_FOUND');
    expect(await code(listQuestions('a1', { sub: 's1', role: 'MEMBER' }, now))).toBe('ok');
  });
  it('DTO masks the asker and flags isMine', () => {
    expect(toQuestionDTO(qRow() as never, 'b1')).toMatchObject({ askerLabel: 'B***l', isMine: true });
    expect(toQuestionDTO(qRow() as never, 'other').isMine).toBe(false);
    expect(toQuestionDTO(qRow() as never, null).isMine).toBe(false);
  });
});

describe('askQuestion', () => {
  it('seller cannot ask on their own auction', async () => {
    expect(await code(askQuestion('s1', 'a1', 'Is it working?', now))).toBe('403:QUESTION_NOT_ALLOWED');
  });
  it('ended or cancelled auctions are closed to questions', async () => {
    db.auction.findUnique.mockResolvedValue(auction({ endTime: new Date(now.getTime() - 1) }));
    expect(await code(askQuestion('b1', 'a1', 'Is it working?', now))).toBe('403:QUESTION_NOT_ALLOWED');
    db.auction.findUnique.mockResolvedValue(auction({ status: 'CANCELLED' }));
    expect(await code(askQuestion('b1', 'a1', 'Is it working?', now))).toBe('403:QUESTION_NOT_ALLOWED');
    expect(db.auctionQuestion.create).not.toHaveBeenCalled();
  });
  it('scheduled auctions accept questions and notify the seller', async () => {
    db.auction.findUnique.mockResolvedValue(
      auction({ status: 'SCHEDULED', startTime: new Date(now.getTime() + H), endTime: new Date(now.getTime() + 5 * H) }),
    );
    db.auctionQuestion.create.mockResolvedValue(qRow());
    const dto = await askQuestion('b1', 'a1', 'Is it working?', now);
    expect(dto).toMatchObject({ id: 'q1', isMine: true });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question-asked', memberId: 's1', dedupeKey: 'question-asked:q1' }),
    );
  });
});

describe('answerQuestion', () => {
  const found = (over: Record<string, unknown> = {}) => ({
    id: 'q1',
    askerId: 'b1',
    auctionId: 'a1',
    answer: null,
    hiddenAt: null,
    auction: { sellerId: 's1' },
    ...over,
  });
  beforeEach(() => {
    db.auctionQuestion.findUnique.mockResolvedValue(found());
    db.auctionQuestion.updateMany.mockResolvedValue({ count: 1 });
  });
  it('only the auction seller', async () => {
    expect(await code(answerQuestion('other', 'q1', 'Yes', now))).toBe('403:FORBIDDEN');
    expect(await code(answerQuestion('adm', 'q1', 'Yes', now))).toBe('403:FORBIDDEN');
  });
  it('only once', async () => {
    db.auctionQuestion.findUnique.mockResolvedValue(found({ answer: 'done' }));
    expect(await code(answerQuestion('s1', 'q1', 'Yes', now))).toBe('409:ALREADY_ANSWERED');
    db.auctionQuestion.findUnique.mockResolvedValue(found());
    db.auctionQuestion.updateMany.mockResolvedValue({ count: 0 });
    expect(await code(answerQuestion('s1', 'q1', 'Yes', now))).toBe('409:ALREADY_ANSWERED');
  });
  it('404 for missing or hidden', async () => {
    db.auctionQuestion.findUnique.mockResolvedValue(found({ hiddenAt: now }));
    expect(await code(answerQuestion('s1', 'q1', 'Yes', now))).toBe('404:QUESTION_NOT_FOUND');
  });
  it('stores the answer and notifies the asker', async () => {
    db.auctionQuestion.findUnique
      .mockResolvedValueOnce(found())
      .mockResolvedValueOnce(qRow({ answer: 'Yes', answeredAt: now }));
    const dto = await answerQuestion('s1', 'q1', 'Yes', now);
    expect(dto).toMatchObject({ answer: 'Yes', answeredAt: now.toISOString() });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question-answered', memberId: 'b1', dedupeKey: 'question-answered:q1' }),
    );
  });
});

describe('hideQuestion', () => {
  beforeEach(() => {
    db.auctionQuestion.findUnique.mockResolvedValue({ id: 'q1', auction: { sellerId: 's1' } });
    db.auctionQuestion.updateMany.mockResolvedValue({ count: 1 });
  });
  it('seller or SUPER_ADMIN, idempotent', async () => {
    expect(await code(hideQuestion({ sub: 'x', role: 'MEMBER' }, 'q1', now))).toBe('403:FORBIDDEN');
    expect(await hideQuestion({ sub: 's1', role: 'MEMBER' }, 'q1', now)).toEqual({ ok: true });
    expect(await hideQuestion({ sub: 'adm', role: 'SUPER_ADMIN' }, 'q1', now)).toEqual({ ok: true });
    expect(db.auctionQuestion.updateMany.mock.calls[0][0]).toEqual({ where: { id: 'q1', hiddenAt: null }, data: { hiddenAt: now } });
  });
  it('404 for unknown', async () => {
    db.auctionQuestion.findUnique.mockResolvedValue(null);
    expect(await code(hideQuestion({ sub: 's1', role: 'MEMBER' }, 'q1', now))).toBe('404:QUESTION_NOT_FOUND');
  });
});
