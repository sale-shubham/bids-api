import { prisma } from '@/core/prisma/client';
import { AppError, BadRequest } from '@/core/errors/AppError';
import { env } from '@/core/config/env';
import { ratingAvg } from '@/modules/reviews/reviews.rules';
import { memberProfileSelect, memberPublicSelect, withMemberMoney, withMemberTrust } from './member.select';
import { gstinMatchesState } from '@/modules/invoices/invoice.rules';
import { activeStrikeCount } from '@/modules/strikes/strikes.service';

export { memberProfileSelect, memberPublicSelect };
// Back-compat alias.
export const profileSelect = memberProfileSelect;

export async function getProfile(memberId: string) {
  const member = await prisma.member.findUnique({ where: { id: memberId }, select: memberProfileSelect });
  return member ? withMemberTrust(withMemberMoney(member)) : null;
}

// Profile + this member's device cap (what the client shows as `member`).
export async function getMemberDto(memberId: string) {
  const member = await getProfile(memberId);
  if (!member) return null;
  const { getMaxDevicesForRole } = await import('@/modules/settings/device-limit.service');
  return {
    ...member,
    activeStrikes: (await activeStrikeCount(prisma, memberId)) ?? 0,
    deviceLimit: await getMaxDevicesForRole(member.role),
  };
}

export async function getPublicProfile(memberId: string, viewerId?: string, now = new Date()) {
  const member = await prisma.member.findFirst({
    where: { id: memberId, isActive: true },
    select: memberPublicSelect,
  });
  if (!member) return null;
  const { statusWhere } = await import('@/modules/auctions/auctions.query');
  const { isFollowing } = await import('@/modules/follows/follows.service');
  const [auctionsSold, activeAuctions, following] = await Promise.all([
    prisma.auction.count({
      where: { AND: [{ sellerId: memberId }, statusWhere('ended', now), { winnerId: { not: null } }] },
    }),
    prisma.auction.count({ where: { AND: [{ sellerId: memberId }, statusWhere('live', now)] } }),
    viewerId ? isFollowing(viewerId, memberId) : Promise.resolve(false),
  ]);
  const { ratingSum, ratingCount, verifiedAt, ...publicFields } = member;
  return { ...publicFields, verified: !!verifiedAt, ratingAvg: ratingAvg(ratingSum, ratingCount), ratingCount, auctionsSold, activeAuctions, isFollowing: following };
}

// Base URLs an avatar may come from: our CloudFront, or the bucket's S3 URL.
export function allowedMediaBases(): string[] {
  const bases: string[] = [];
  if (env.storage.cdnBaseUrl) bases.push(env.storage.cdnBaseUrl);
  const { bucket, region } = env.storage.s3;
  if (bucket) bases.push(`https://${bucket}.s3.${region}.amazonaws.com`);
  return bases.map((b) => b.replace(/\/+$/, '') + '/');
}

export function isOwnMediaUrl(url: string, bases: string[] = allowedMediaBases()): boolean {
  return bases.some((b) => url.startsWith(b));
}

// Empty strings clear the optional fields.
export async function updateProfile(
  memberId: string,
  input: { name?: string; phone?: string | null; address?: string | null; avatarUrl?: string | null; gstin?: string | null; billingState?: string | null },
) {
  if (input.avatarUrl && !isOwnMediaUrl(input.avatarUrl)) {
    throw BadRequest('avatarUrl must be an uploaded image from this platform');
  }
  if (input.gstin !== undefined || input.billingState !== undefined) {
    const cur = await prisma.member.findUnique({ where: { id: memberId }, select: { gstin: true, billingState: true } });
    const gstin = input.gstin !== undefined ? input.gstin || null : (cur?.gstin ?? null);
    const state = input.billingState !== undefined ? input.billingState || null : (cur?.billingState ?? null);
    if (!gstinMatchesState(gstin, state)) throw new AppError(400, 'INVALID_GSTIN', 'The GSTIN does not match the billing state');
  }
  const data: Record<string, string | Date | null> = {};
  if (input.name !== undefined) data.name = input.name;
  for (const k of ['phone', 'address', 'avatarUrl', 'gstin', 'billingState'] as const) {
    if (input[k] !== undefined) data[k] = input[k] || null;
  }
  const updated = await prisma.member.update({ where: { id: memberId }, data, select: memberProfileSelect });
  return withMemberTrust(withMemberMoney(updated));
}
