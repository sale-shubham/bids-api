import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

// GET /members/me carries the caller's own device cap, picked by role — the
// app's Profile page shows its Devices tab only when it is above 1.
const config = { memberLimit: 3, superAdminLimit: 1 };

vi.mock('@/modules/settings/device-limit.service', () => ({
  getMaxDevicesForRole: async (role: string) => (role === 'SUPER_ADMIN' ? config.superAdminLimit : config.memberLimit),
}));
vi.mock('@/core/prisma/client', () => ({
  prisma: {
    strike: { count: async () => 1 },
    member: {
      findUnique: async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        role: where.id === 'admin' ? 'SUPER_ADMIN' : 'MEMBER',
        email: 'a@example.com',
        name: 'A',
        isActive: true,
        unpaidCommissionPaise: 0n,
        moneySpentPaise: 0n,
        createdAt: new Date(0),
      }),
    },
  },
}));

async function callMe(sub: string) {
  const { me } = await import('./members.controller');
  let body: { data: Record<string, unknown> } | undefined;
  const res = {
    status: () => res,
    json: (b: typeof body) => {
      body = b;
      return res;
    },
  } as unknown as Response;
  await me({ user: { sub } } as unknown as Request, res);
  return (body!.data as { member: Record<string, unknown> }).member;
}

describe('GET /members/me deviceLimit', () => {
  it("returns a member's memberLimit", async () => {
    expect(await callMe('m1')).toMatchObject({ role: 'MEMBER', deviceLimit: 3, activeStrikes: 1 });
  });

  it("returns a super admin's superAdminLimit", async () => {
    expect(await callMe('admin')).toMatchObject({ role: 'SUPER_ADMIN', deviceLimit: 1 });
  });
});
