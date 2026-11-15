import { prisma } from '@/core/prisma/client';
import { toPaise } from '@/core/money';
import { offsetArgs, pageMeta } from '@/core/http/pagination';

export async function listPayments(q: { status?: 'created' | 'paid' | 'failed'; page: number; pageSize: number }) {
  const where = q.status ? { status: q.status.toUpperCase() as 'CREATED' | 'PAID' | 'FAILED' } : {};
  const [rows, total] = await Promise.all([
    prisma.paymentOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        amountPaise: true,
        status: true,
        gatewayOrderId: true,
        gatewayPaymentId: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
        member: { select: { id: true, name: true, email: true } },
      },
      ...offsetArgs(q),
    }),
    prisma.paymentOrder.count({ where }),
  ]);
  return { items: rows.map((r) => ({ ...r, amountPaise: toPaise(r.amountPaise) })), meta: pageMeta(total, q) };
}
