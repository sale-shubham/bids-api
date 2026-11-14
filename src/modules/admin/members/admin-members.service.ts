import { prisma } from '@/core/prisma/client';
import { offsetArgs, buildOrderBy, type SortOrder } from '@/core/http/pagination';
import { NotFound } from '@/core/errors/AppError';
import type { Prisma, Role } from '@prisma/client';

// Backs the admin Members page: list, activate/deactivate, change role.

interface ListParams {
  status?: 'active' | 'inactive';
  role?: Role;
  search?: string;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: SortOrder;
}

const MEMBER_SORT_MAP: Record<string, (order: SortOrder) => Prisma.MemberOrderByWithRelationInput> = {
  name: (order) => ({ name: order }),
  email: (order) => ({ email: order }),
  role: (order) => ({ role: order }),
  createdAt: (order) => ({ createdAt: order }),
  isActive: (order) => ({ isActive: order }),
};

const memberSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  emailVerifiedAt: true,
  unpaidCommissionPaise: true,
  auctionsWon: true,
  moneySpentPaise: true,
  createdAt: true,
} satisfies Prisma.MemberSelect;

export async function listMembers(params: ListParams) {
  const search = params.search?.trim();
  const where: Prisma.MemberWhereInput = {
    ...(params.role ? { role: params.role } : {}),
    ...(params.status === 'active' ? { isActive: true } : {}),
    ...(params.status === 'inactive' ? { isActive: false } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const orderBy = buildOrderBy(params.sortBy, params.sortOrder, MEMBER_SORT_MAP, { createdAt: 'desc' });

  const [items, total, stats] = await Promise.all([
    prisma.member.findMany({ where, select: memberSelect, orderBy, ...offsetArgs(params) }),
    prisma.member.count({ where }),
    getMemberStats(),
  ]);

  return { items, total, stats };
}

// Tab counts — always the full All/Active/Inactive split, independent of the filter.
export async function getMemberStats() {
  const [total, active, inactive] = await Promise.all([
    prisma.member.count(),
    prisma.member.count({ where: { isActive: true } }),
    prisma.member.count({ where: { isActive: false } }),
  ]);
  return { total, active, inactive };
}

// Suspend/reactivate. Suspending also kills every live Session + WebSocket
// connection so it takes effect immediately, not at natural token expiry.
export async function setMemberActive(id: string, isActive: boolean) {
  const member = await prisma.member.findUnique({ where: { id }, select: { id: true } });
  if (!member) throw NotFound('Member not found');

  const updated = await prisma.member.update({
    where: { id },
    data: { isActive },
    select: { id: true, isActive: true },
  });

  if (!isActive) {
    await prisma.session.deleteMany({ where: { memberId: id } });
    const { disconnectMemberConnections } = await import('@/modules/ws/ws.service');
    await disconnectMemberConnections(id).catch(() => {});
  }

  return updated;
}

export async function setMemberRole(id: string, role: Role) {
  const member = await prisma.member.findUnique({ where: { id }, select: { id: true } });
  if (!member) throw NotFound('Member not found');
  return prisma.member.update({ where: { id }, data: { role }, select: { id: true, role: true } });
}
