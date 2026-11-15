import { prisma } from '@/core/prisma/client';
import { AppError, NotFound } from '@/core/errors/AppError';
import { logger } from '@/core/logger/logger';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { isStrikeActive, strikeAction, strikeExpiry } from './strikes.rules';

type CountDb = { strike: Pick<typeof prisma.strike, 'count'> };

export const activeWhere = (now: Date) => ({ removedAt: null, expiresAt: { gt: now } });

/** Active strikes of a member (not removed, not expired). */
export async function activeStrikeCount(db: CountDb, memberId: string, now = new Date()): Promise<number> {
  return db.strike.count({ where: { memberId, ...activeWhere(now) } });
}

type StrikeTx = { strike: Pick<typeof prisma.strike, 'create' | 'count'> };

/** Create the UNPAID strike for a cancelled sale (call inside the cancel transaction). Returns the new active count. */
export async function createUnpaidStrike(tx: StrikeTx, sale: { id: string; buyerId: string }, now: Date) {
  const strike = await tx.strike.create({
    data: { memberId: sale.buyerId, saleId: sale.id, reason: 'UNPAID', expiresAt: strikeExpiry(now) },
    select: { id: true, expiresAt: true },
  });
  const activeCount = await activeStrikeCount(tx, sale.buyerId, now);
  return { strike, activeCount };
}

/** Deactivate the account the way an admin suspension does: kill sessions and live connections. */
export async function suspendMember(memberId: string): Promise<void> {
  await prisma.member.update({ where: { id: memberId }, data: { isActive: false } });
  await prisma.session.deleteMany({ where: { memberId } });
  try {
    const { disconnectMemberConnections } = await import('@/modules/ws/ws.service');
    await disconnectMemberConnections(memberId);
  } catch (err) {
    logger.warn({ err, memberId }, 'strikes: could not disconnect websocket connections');
  }
}

/** After a strike is stored: warn, require deposits, or suspend (3+). Best effort, never throws. */
export async function applyStrikePolicy(s: {
  strikeId: string;
  memberId: string;
  auctionId: string;
  activeCount: number;
  expiresAt: Date;
}): Promise<void> {
  try {
    const action = strikeAction(s.activeCount);
    if (action === 'SUSPEND') {
      // Notify first: the notify pipeline skips inactive members (except account-suspended).
      await enqueueNotification({
        type: 'account-suspended',
        memberId: s.memberId,
        auctionId: s.auctionId,
        data: { strikeCount: s.activeCount },
        dedupeKey: `account-suspended:${s.strikeId}`,
      });
      await suspendMember(s.memberId);
      return;
    }
    await enqueueNotification({
      type: 'strike-issued',
      memberId: s.memberId,
      auctionId: s.auctionId,
      data: { strikeCount: s.activeCount, depositsRequired: action === 'DEPOSITS_REQUIRED', expiresAt: s.expiresAt.toISOString() },
      dedupeKey: `strike-issued:${s.strikeId}`,
    });
  } catch (err) {
    logger.error({ err, strikeId: s.strikeId }, 'strikes: policy follow-up failed');
  }
}

// ---------------------------------------------------------------- admin

type StrikeRow = {
  id: string;
  memberId: string;
  saleId: string;
  reason: 'UNPAID';
  createdAt: Date;
  expiresAt: Date;
  removedAt: Date | null;
  removedById: string | null;
  note: string | null;
  sale?: { auctionId: string; auction: { title: string } } | null;
};

export function toStrikeDTO(s: StrikeRow, now = new Date()) {
  return {
    id: s.id,
    memberId: s.memberId,
    saleId: s.saleId,
    auction: s.sale ? { id: s.sale.auctionId, title: s.sale.auction.title } : null,
    reason: s.reason,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    removedAt: s.removedAt,
    removedById: s.removedById,
    note: s.note,
    active: isStrikeActive(s, now),
  };
}

const strikeSelect = {
  id: true,
  memberId: true,
  saleId: true,
  reason: true,
  createdAt: true,
  expiresAt: true,
  removedAt: true,
  removedById: true,
  note: true,
  sale: { select: { auctionId: true, auction: { select: { title: true } } } },
} as const;

/** GET /admin/members/:id/strikes */
export async function listMemberStrikes(memberId: string, now = new Date()) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true } });
  if (!member) throw NotFound('Member not found');
  const rows = await prisma.strike.findMany({ where: { memberId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: strikeSelect });
  return { items: (rows as StrikeRow[]).map((r) => toStrikeDTO(r, now)) };
}

/** POST /admin/strikes/:id/remove. Does not unsuspend the member (the admin does that with the member PATCH). */
export async function removeStrike(id: string, adminId: string, note: string | undefined, now = new Date()) {
  const strike = await prisma.strike.findUnique({ where: { id }, select: { id: true, removedAt: true } });
  if (!strike) throw new AppError(404, 'STRIKE_NOT_FOUND', 'Strike not found');
  if (strike.removedAt) throw new AppError(409, 'STRIKE_ALREADY_REMOVED', 'This strike was already removed');
  const { count } = await prisma.strike.updateMany({
    where: { id, removedAt: null },
    data: { removedAt: now, removedById: adminId, note: note || null },
  });
  if (count === 0) throw new AppError(409, 'STRIKE_ALREADY_REMOVED', 'This strike was already removed');
  const row = await prisma.strike.findUniqueOrThrow({ where: { id }, select: strikeSelect });
  logger.info({ strikeId: id, adminId }, 'strike removed');
  return { strike: toStrikeDTO(row as StrikeRow, now) };
}
