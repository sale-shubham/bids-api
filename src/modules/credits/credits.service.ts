import { prisma, type TransactionClient } from '@/core/prisma/client';
import { AppError, NotFound } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { offsetArgs, pageMeta } from '@/core/http/pagination';

export type CreditReasonValue = 'REFERRAL_REWARD' | 'FEATURE_PURCHASE' | 'COMMISSION_PAYMENT' | 'ADMIN_ADJUSTMENT';

type Db = Pick<TransactionClient, 'memberCredit'>;

export const insufficientCredits = () => new AppError(409, 'INSUFFICIENT_CREDITS', 'Not enough credits for this payment');

/** Credit balance = sum of the member's ledger rows. */
export async function creditBalance(db: Db, memberId: string): Promise<number> {
  const agg = await db.memberCredit.aggregate({ where: { memberId }, _sum: { amountPaise: true } });
  return agg._sum.amountPaise === null || agg._sum.amountPaise === undefined ? 0 : toPaise(agg._sum.amountPaise);
}

/** Serialises concurrent ledger writes for one member (row lock held until the transaction ends). */
export async function lockMember(tx: TransactionClient, memberId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`;
}

export type LedgerEntry = {
  memberId: string;
  amountPaise: number; // positive
  reason: CreditReasonValue;
  refType?: string;
  refId?: string;
  note?: string;
  createdById?: string;
};

/** Add credits (positive ledger row). Call inside a transaction. */
export async function grantCredits(tx: TransactionClient, e: LedgerEntry) {
  return tx.memberCredit.create({
    data: { memberId: e.memberId, amountPaise: BigInt(e.amountPaise), reason: e.reason, refType: e.refType ?? null, refId: e.refId ?? null, note: e.note ?? null, createdById: e.createdById ?? null },
    select: { id: true },
  });
}

/**
 * Spend credits (negative ledger row). Must run inside the caller's transaction: it locks the member row, re-reads
 * the balance and throws 409 INSUFFICIENT_CREDITS rather than let it go below 0.
 */
export async function debitCredits(tx: TransactionClient, e: LedgerEntry) {
  await lockMember(tx, e.memberId);
  const balance = await creditBalance(tx, e.memberId);
  if (balance < e.amountPaise) throw insufficientCredits();
  return tx.memberCredit.create({
    data: { memberId: e.memberId, amountPaise: BigInt(-e.amountPaise), reason: e.reason, refType: e.refType ?? null, refId: e.refId ?? null, note: e.note ?? null, createdById: e.createdById ?? null },
    select: { id: true },
  });
}

export async function listLedger(memberId: string, q: { page: number; pageSize: number }) {
  const where = { memberId };
  const [rows, total, balancePaise] = await Promise.all([
    prisma.memberCredit.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, amountPaise: true, reason: true, note: true, createdAt: true },
      ...offsetArgs(q),
    }),
    prisma.memberCredit.count({ where }),
    creditBalance(prisma, memberId),
  ]);
  const items = rows.map((r) => ({ id: r.id, amountPaise: toPaise(r.amountPaise), reason: r.reason, note: r.note, createdAt: r.createdAt }));
  return { items, meta: pageMeta(total, q), balancePaise };
}

/** Admin ledger adjustment (+/-). A debit cannot take the balance below 0. */
export async function adminAdjust(memberId: string, adminId: string, input: { amountPaise: number; note: string }) {
  const exists = await prisma.member.findUnique({ where: { id: memberId }, select: { id: true } });
  if (!exists) throw NotFound('Member not found');
  const entry: LedgerEntry = { memberId, amountPaise: Math.abs(input.amountPaise), reason: 'ADMIN_ADJUSTMENT', note: input.note, createdById: adminId };
  await prisma.$transaction(async (tx) => {
    if (input.amountPaise > 0) {
      await lockMember(tx, memberId);
      await grantCredits(tx, entry);
    } else {
      await debitCredits(tx, entry);
    }
  });
  return { creditBalancePaise: await creditBalance(prisma, memberId) };
}

/** Balances for many members at once (admin member list). */
export async function balancesFor(memberIds: string[]): Promise<Map<string, number>> {
  if (memberIds.length === 0) return new Map();
  const rows = await prisma.memberCredit.groupBy({ by: ['memberId'], where: { memberId: { in: memberIds } }, _sum: { amountPaise: true } });
  return new Map(rows.map((r) => [r.memberId, r._sum.amountPaise === null ? 0 : toPaise(r._sum.amountPaise)]));
}
