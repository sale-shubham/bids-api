import { prisma } from '@/core/prisma/client';
import { BadRequest } from '@/core/errors/AppError';
import { DEFAULT_PREF, NOTIFY_CATALOGUE, isMandatoryEmail } from '@/modules/notify/notify.catalogue';
import { NOTIFY_TYPES, type NotifyType } from '@/modules/notify/notify.types';

type Role = 'MEMBER' | 'SUPER_ADMIN';
export type PreferenceInput = { type: NotifyType; email: boolean; push: boolean };

const visibleTypes = (role: Role) => NOTIFY_TYPES.filter((t) => !NOTIFY_CATALOGUE[t].adminOnly || role === 'SUPER_ADMIN');

export async function getPreferences(memberId: string, role: Role) {
  const rows = await prisma.notificationPreference.findMany({ where: { memberId }, select: { type: true, email: true, push: true } });

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
      emailLocked,
    };
  });
  return { items };
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
