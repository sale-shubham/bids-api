import { prisma } from '@/core/prisma/client';
import { AppError, Forbidden } from '@/core/errors/AppError';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { auctionNotFound } from '@/modules/auctions/auctions.service';
import { effectiveStatus } from '@/modules/auctions/auctions.serializer';
import { questionInclude, toQuestionDTO, visibilityWhere } from './questions.rules';

const MAX_LISTED = 100;
type Viewer = { sub: string; role: string } | undefined;

export const questionNotFound = () => new AppError(404, 'QUESTION_NOT_FOUND', 'Question not found');
const alreadyAnswered = () => new AppError(409, 'ALREADY_ANSWERED', 'This question has already been answered');
const auctionSelect = { id: true, sellerId: true, status: true, deletedAt: true, startTime: true, endTime: true } as const;

export async function listQuestions(auctionId: string, viewer: Viewer, now = new Date()) {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: auctionSelect });
  if (!auction) throw auctionNotFound();
  const privileged = !!viewer && (viewer.role === 'SUPER_ADMIN' || viewer.sub === auction.sellerId);
  if (effectiveStatus(auction, now) === 'CANCELLED' && !privileged) throw auctionNotFound();

  const rows = await prisma.auctionQuestion.findMany({
    where: { auctionId, hiddenAt: null, ...visibilityWhere(viewer, auction.sellerId) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_LISTED,
    include: questionInclude,
  });
  return { items: rows.map((r) => toQuestionDTO(r, viewer?.sub)) };
}

export async function askQuestion(memberId: string, auctionId: string, question: string, now = new Date()) {
  const auction = await prisma.auction.findUnique({ where: { id: auctionId }, select: auctionSelect });
  if (!auction) throw auctionNotFound();
  const status = effectiveStatus(auction, now);
  if (auction.sellerId === memberId || (status !== 'SCHEDULED' && status !== 'LIVE')) {
    throw new AppError(403, 'QUESTION_NOT_ALLOWED', 'You cannot ask a question on this auction');
  }
  const row = await prisma.auctionQuestion.create({ data: { auctionId, askerId: memberId, question }, include: questionInclude });
  await enqueueNotification({
    type: 'question-asked',
    memberId: auction.sellerId,
    auctionId,
    data: { question },
    dedupeKey: `question-asked:${row.id}`,
  });
  return toQuestionDTO(row, memberId);
}

export async function answerQuestion(memberId: string, questionId: string, answer: string, now = new Date()) {
  const q = await prisma.auctionQuestion.findUnique({
    where: { id: questionId },
    select: { id: true, askerId: true, auctionId: true, answer: true, hiddenAt: true, auction: { select: { sellerId: true } } },
  });
  if (!q || q.hiddenAt) throw questionNotFound();
  if (q.auction.sellerId !== memberId) throw Forbidden('Only the seller of this auction can answer');
  if (q.answer) throw alreadyAnswered();
  // answer: null in the WHERE closes the race with a concurrent answer.
  const { count } = await prisma.auctionQuestion.updateMany({ where: { id: questionId, answer: null }, data: { answer, answeredAt: now } });
  if (count === 0) throw alreadyAnswered();
  const row = await prisma.auctionQuestion.findUnique({ where: { id: questionId }, include: questionInclude });
  if (!row) throw questionNotFound();
  await enqueueNotification({
    type: 'question-answered',
    memberId: q.askerId,
    auctionId: q.auctionId,
    data: { answer },
    dedupeKey: `question-answered:${questionId}`,
  });
  return toQuestionDTO(row, memberId);
}

export async function hideQuestion(actor: { sub: string; role: string }, questionId: string, now = new Date()) {
  const q = await prisma.auctionQuestion.findUnique({
    where: { id: questionId },
    select: { id: true, auction: { select: { sellerId: true } } },
  });
  if (!q) throw questionNotFound();
  if (actor.role !== 'SUPER_ADMIN' && q.auction.sellerId !== actor.sub) throw Forbidden('Only the seller of this auction can hide a question');
  await prisma.auctionQuestion.updateMany({ where: { id: questionId, hiddenAt: null }, data: { hiddenAt: now } });
  return { ok: true };
}
