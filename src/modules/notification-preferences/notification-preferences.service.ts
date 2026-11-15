import { prisma } from '@/core/prisma/client';
import { AppError, BadRequest } from '@/core/errors/AppError';
import { DEFAULT_PREF, NOTIFY_CATALOGUE, isMandatoryEmail } from '@/modules/notify/notify.catalogue';
import { NOTIFY_TYPES, type NotifyType } from '@/modules/notify/notify.types';

type Role = 'BIDDER' | 'AUCTIONEER' | 'SUPER_ADMIN';
export type PreferenceInput = { type: NotifyType; email: boolean; push: boolean; whatsapp: boolean };

const visibleTypes = (role: Role) => NOTIFY_TYPES.filter((t) => !NOTIFY_CATALOGUE[t].adminOnly || role === 'SUPER_ADMIN');

export async function getPreferences(memberId: string, role: Role) {
  const [rows, member] = await Promise.all([
    prisma.notificationPreference.findMany({ where: { memberId }, select: { type: true, email: true, push: true, whatsapp: true } }),
    prisma.member.findUnique({ where: { id: memberId }, select: { whatsappOptInAt: true, phoneVerifiedAt: true } }),
  ]);
  const byType = new Map(rows.map((r) => [r.type, r]));
  const items = visibleTypes(role).map((type) => {
    const c = NOTIFY_CATALOGUE[type];
    const p = byType.get(type) ?? DEFAULT_PREF;
    const emailLocked = isMandatoryEmail(type);
    return {
      type,
      label: c.label,
      group: c.group,
      email: emailLocked ? true : p.email,
      push: p.push,
      whatsapp: c.whatsappCapable ? p.whatsapp : false,
      emailLocked,
      whatsappCapable: c.whatsappCapable,
    };
  });
  return { items, whatsappOptIn: !!member?.whatsappOptInAt, phoneVerified: !!member?.phoneVerifiedAt };
}

export async function updatePreferences(memberId: string, role: Role, items: PreferenceInput[]) {
  const allowed = new Set<string>(visibleTypes(role));
  const bad = items.find((i) => !allowed.has(i.type));
  if (bad) throw BadRequest(`Unknown notification type: ${bad.type}`);
  await prisma.$transaction(
    items.map((i) => {
      const data = {
        email: isMandatoryEmail(i.type) ? true : i.email,
        push: i.push,
        whatsapp: NOTIFY_CATALOGUE[i.type].whatsappCapable ? i.whatsapp : false,
      };
      return prisma.notificationPreference.upsert({
        where: { memberId_type: { memberId, type: i.type } },
        create: { memberId, type: i.type, ...data },
        update: data,
      });
    }),
  );
  return getPreferences(memberId, role);
}

/** Opting in needs a verified phone; opting out is always allowed. */
export async function setWhatsappOptIn(memberId: string, optIn: boolean, now = new Date()) {
  if (optIn) {
    const m = await prisma.member.findUnique({ where: { id: memberId }, select: { phoneVerifiedAt: true } });
    if (!m?.phoneVerifiedAt) throw new AppError(409, 'PHONE_NOT_VERIFIED', 'Verify your phone number to turn on WhatsApp alerts');
  }
  await prisma.member.update({ where: { id: memberId }, data: { whatsappOptInAt: optIn ? now : null } });
  return { whatsappOptIn: optIn };
}
