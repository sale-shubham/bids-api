import { bidderLabel } from '@/modules/auctions/bidding.rules';

export type QuestionDTO = {
  id: string;
  auctionId: string;
  question: string;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
  askerLabel: string;
  isMine: boolean;
};

export type QuestionRow = {
  id: string;
  auctionId: string;
  askerId: string;
  question: string;
  answer: string | null;
  answeredAt: Date | null;
  createdAt: Date;
  asker: { name: string };
};

export const questionInclude = { asker: { select: { name: true } } } as const;

export function toQuestionDTO(q: QuestionRow, viewerId?: string | null): QuestionDTO {
  return {
    id: q.id,
    auctionId: q.auctionId,
    question: q.question,
    answer: q.answer,
    answeredAt: q.answeredAt ? q.answeredAt.toISOString() : null,
    createdAt: q.createdAt.toISOString(),
    askerLabel: bidderLabel(q.asker.name),
    isMine: !!viewerId && q.askerId === viewerId,
  };
}

/** Everyone sees answered questions; the asker also sees their own pending; the seller / SUPER_ADMIN see all. */
export function visibilityWhere(viewer: { sub: string; role: string } | undefined, sellerId: string) {
  if (viewer && (viewer.role === 'SUPER_ADMIN' || viewer.sub === sellerId)) return {};
  return { OR: [{ answer: { not: null } }, ...(viewer ? [{ askerId: viewer.sub }] : [])] };
}
