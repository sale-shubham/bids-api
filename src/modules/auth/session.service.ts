import type { Role } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { getMaxDevicesForRole } from '@/modules/settings/device-limit.service';

export interface DeviceMeta {
  userAgent?: string;
  ip?: string;
  deviceInfo?: { browser?: string; os?: string; device?: string; type?: string };
}

// Called only at login/signup completion (never on refresh), so a token
// refresh never counts as a "login" for eviction purposes.
//
// Every login trims the member down to the limit: this device plus the newest
// (limit - 1) OTHER sessions survive, everything older is deleted. It used to
// delete only ONE oldest session per login, which never caught up once a
// member held more sessions than the limit — e.g. 2 open devices when the
// admin lowered the limit to 1: each new login removed one and added one, so
// the member stayed at 2 forever and a limit of 1 behaved like 2. Re-logging
// in on an already-known deviceId trims too (it used to skip eviction
// entirely), but that device itself never counts against the others.
export async function upsertDeviceSession(memberId: string, role: Role, deviceId: string, meta: DeviceMeta) {
  const maxDevices = await getMaxDevicesForRole(role);

  // Newest first by createdAt, so the oldest-logged-in devices are the ones
  // that fall off the end — same "first in, first out" rule as before, not
  // least-recently-used.
  const others = await prisma.session.findMany({
    where: { memberId, NOT: { deviceId } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const evicted = others.slice(Math.max(maxDevices - 1, 0));
  if (evicted.length > 0) {
    await prisma.session.deleteMany({ where: { id: { in: evicted.map((s) => s.id) } } });
    // Force-close the evicted devices' live WebSockets too — otherwise they keep receiving live pushes even after their REST calls start 401ing on the deleted
    // Session rows. Best-effort, dynamic import matches the rest of this
    // codebase's convention for optional cross-module side effects — must never fail
    // the login that triggered the eviction.
    const { disconnectMemberConnections } = await import('@/modules/ws/ws.service');
    await disconnectMemberConnections(memberId).catch(() => {});
  }

  const existing = await prisma.session.findUnique({
    where: { memberId_deviceId: { memberId, deviceId } },
  });
  if (existing) {
    return prisma.session.update({
      where: { id: existing.id },
      data: { lastUsedAt: new Date(), ...meta },
    });
  }
  return prisma.session.create({ data: { memberId, deviceId, ...meta } });
}

export async function touchSession(sessionId: string): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } }).catch(() => {});
}

// Self-service device management — lets an account (SUPER_ADMIN included,
// since SUPER_ADMIN has no separate login/session mechanism from Member) see
// and remove its own logged-in devices one at a time, without waiting for
// FIFO eviction or nuking every device via logout-all.
export async function listSessions(memberId: string) {
  return prisma.session.findMany({ where: { memberId }, orderBy: { createdAt: 'desc' } });
}

// Returns false (caller 404s) if the session doesn't exist or belongs to a
// different member — never leaks which is the case.
export async function revokeSession(memberId: string, sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.memberId !== memberId) return false;

  await prisma.session.delete({ where: { id: sessionId } });
  // Same best-effort WebSocket cleanup as FIFO eviction (upsertDeviceSession
  // above) — WsConnection is keyed to memberId, not Session.id, so this force
  // -closes every live connection for the member, not just the removed
  // device's. Must never fail the removal itself.
  const { disconnectMemberConnections } = await import('@/modules/ws/ws.service');
  await disconnectMemberConnections(memberId).catch(() => {});
  return true;
}
