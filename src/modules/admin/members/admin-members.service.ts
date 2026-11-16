import { prisma } from '@/core/prisma/client';
import { offsetArgs, buildOrderBy, type SortOrder } from '@/core/http/pagination';
import { AppError, NotFound } from '@/core/errors/AppError';
import type { Prisma } from '@prisma/client';
import { withMemberMoney } from '@/modules/members/member.select';
import { balancesFor, creditBalance } from '@/modules/credits/credits.service';
import { refreshSellerVerification } from '@/modules/members/verification.service';

// Backs the admin Members page: list, update (active / verified).

type AdminMemberRow = Prisma.MemberGetPayload<{ select: ReturnType<typeof memberSelect> }>;

/** Admin DTO: boolean for verified, payout status, money as numbers. */
function toAdminDto(m: AdminMemberRow, creditBalancePaise = 0) {
  const { verifiedAt, payoutAccount, _count, ...rest } = m;
  return {
    ...withMemberMoney(rest),
    verified: !!verifiedAt,
    payoutStatus: payoutAccount?.status ?? null,
    activeStrikes: _count?.strikes ?? 0,
    auctionsListed: _count?.auctionsSelling ?? 0,
    creditBalancePaise,
  };
}

// Super admins are never listed or managed here; every per-member admin route treats them as unknown (404).
const NOT_SUPER_ADMIN = { role: { not: 'SUPER_ADMIN' as const } };

interface ListParams {
  status?: 'active' | 'inactive';
  seller?: boolean;
  search?: string;
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: SortOrder;
}

const MEMBER_SORT_MAP: Record<string, (order: SortOrder) => Prisma.MemberOrderByWithRelationInput> = {
  name: (order) => ({ name: order }),
  email: (order) => ({ email: order }),
  createdAt: (order) => ({ createdAt: order }),
  isActive: (order) => ({ isActive: order }),
};

const memberSelect = (now = new Date()) => ({
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  emailVerifiedAt: true,
  verifiedAt: true,
  payoutAccount: { select: { status: true } },
  unpaidCommissionPaise: true,
  auctionsWon: true,
  moneySpentPaise: true,
  createdAt: true,
  _count: { select: { auctionsSelling: true, strikes: { where: { removedAt: null, expiresAt: { gt: now } } } } },
}) satisfies Prisma.MemberSelect;

export async function listMembers(params: ListParams) {
  const search = params.search?.trim();
  const where: Prisma.MemberWhereInput = {
    AND: [NOT_SUPER_ADMIN], // base clause: filters below can never override it
    ...(params.seller === true ? { auctionsSelling: { some: {} } } : {}),
    ...(params.seller === false ? { auctionsSelling: { none: {} } } : {}),
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
    prisma.member.findMany({ where, select: memberSelect(), orderBy, ...offsetArgs(params) }),
    prisma.member.count({ where }),
    getMemberStats(),
  ]);

  const balances = await balancesFor(items.map((m) => m.id));
  return { items: items.map((m) => toAdminDto(m, balances.get(m.id) ?? 0)), total, stats };
}

/** 404 when the target is a super admin (unknown ids fall through to the caller's own 404). */
export async function assertManageable(id: string) {
  const target = await prisma.member.findUnique({ where: { id }, select: { role: true } });
  if (target?.role === 'SUPER_ADMIN') throw NotFound('Member not found');
}

// Tab counts — always the full All/Active/Inactive split, independent of the filter.
export async function getMemberStats() {
  const [total, active, inactive] = await Promise.all([
    prisma.member.count({ where: NOT_SUPER_ADMIN }),
    prisma.member.count({ where: { ...NOT_SUPER_ADMIN, isActive: true } }),
    prisma.member.count({ where: { ...NOT_SUPER_ADMIN, isActive: false } }),
  ]);
  return { total, active, inactive };
}

export const cannotModifySelf = () =>
  new AppError(409, 'CANNOT_MODIFY_SELF', 'You cannot deactivate your own account');

/**
 * Update a member's active flag and/or verified badge. An admin can never
 * deactivate themselves (no accidental lock-out). Deactivating
 * kills every live Session + WebSocket connection so it takes effect at once.
 */
export async function updateMember(
  id: string,
  actorId: string,
  input: { isActive?: boolean; verified?: boolean },
) {
  if (id === actorId && input.isActive === false) throw cannotModifySelf();

  const existing = await prisma.member.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!existing || existing.role === 'SUPER_ADMIN') throw NotFound('Member not found');

  const data: Prisma.MemberUpdateInput = {};
  if (input.isActive !== undefined) data.isActive = input.isActive;
  // verified=false revokes (wins over the rule); verified=true lifts the revoke, then the rule re-decides.
  if (input.verified === false) {
    data.verificationRevokedAt = new Date();
    data.verifiedAt = null;
  } else if (input.verified === true) {
    data.verificationRevokedAt = null;
  }
  let member = await prisma.member.update({ where: { id }, data, select: memberSelect() });
  if (input.verified === true) {
    await refreshSellerVerification(id);
    member = (await prisma.member.findUnique({ where: { id }, select: memberSelect() })) ?? member;
  }

  if (input.isActive === false) {
    await prisma.session.deleteMany({ where: { memberId: id } });
    const { disconnectMemberConnections } = await import('@/modules/ws/ws.service');
    await disconnectMemberConnections(id).catch(() => {});
  }
  return toAdminDto(member, await creditBalance(prisma, id));
}
