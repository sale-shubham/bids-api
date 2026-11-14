import { prisma } from '@/core/prisma/client';
import { NotFound } from '@/core/errors/AppError';
import { offsetArgs, pageMeta } from '@/core/http/pagination';

const select = { id: true, type: true, title: true, body: true, url: true, readAt: true, createdAt: true } as const;

export async function listNotifications(memberId: string, q: { page: number; pageSize: number }) {
  const { skip, take } = offsetArgs(q);
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where: { memberId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
      select,
    }),
    prisma.notification.count({ where: { memberId } }),
  ]);
  return {
    items: rows.map((n) => ({
      ...n,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    })),
    meta: pageMeta(total, q),
  };
}

export async function unreadCount(memberId: string) {
  return { count: await prisma.notification.count({ where: { memberId, readAt: null } }) };
}

// Idempotent: re-reading an already-read notification is fine. Not the caller's -> 404.
export async function markRead(memberId: string, id: string) {
  const row = await prisma.notification.findFirst({ where: { id, memberId }, select: { id: true } });
  if (!row) throw NotFound('Notification not found');
  await prisma.notification.updateMany({ where: { id, memberId, readAt: null }, data: { readAt: new Date() } });
  return { id };
}

export async function markAllRead(memberId: string) {
  const { count } = await prisma.notification.updateMany({ where: { memberId, readAt: null }, data: { readAt: new Date() } });
  return { count };
}
