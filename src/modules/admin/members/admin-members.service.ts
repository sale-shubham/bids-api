import { prisma } from '@/core/prisma/client';
import { offsetArgs, buildOrderBy, type SortOrder } from '@/core/http/pagination';
import { AppError, NotFound } from '@/core/errors/AppError';
import type { Prisma, Role } from '@prisma/client';
import { withMemberMoney } from '@/modules/members/member.select';

// Backs the admin Members page: list, update (active / role).

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

  return { items: items.map(withMemberMoney), total, stats };
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

export const cannotModifySelf = () =>
  new AppError(409, 'CANNOT_MODIFY_SELF', 'You cannot change your own role or deactivate your own account');

/**
 * Update a member's active flag and/or role. An admin can never change their
 * own role or deactivate themselves (no accidental lock-out). Deactivating
 * kills every live Session + WebSocket connection so it takes effect at once.
 */
export async function updateMember(id: string, actorId: string, input: { isActive?: boolean; role?: Role }) {
  if (id === actorId && (input.isActive === false || input.role !== undefined)) throw cannotModifySelf();

  const existing = await prisma.member.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw NotFound('Member not found');

  const data: Prisma.MemberUpdateInput = {};
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.role !== undefined) data.role = input.role;
  const member = await prisma.member.update({ where: { id }, data, select: memberSelect });

  if (input.isActive === false) {
    await prisma.session.deleteMany({ where: { memberId: id } });
    const { disconnectMemberConnections } = await import('@/modules/ws/ws.service');
    await disconnectMemberConnections(id).catch(() => {});
  }
  return withMemberMoney(member);
}
