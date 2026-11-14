import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory stand-in for the Session table — just enough of the Prisma calls
// upsertDeviceSession makes.
type Row = { id: string; memberId: string; deviceId: string; createdAt: Date };
let rows: Row[] = [];
let seq = 0;
let limit = 1;

vi.mock('@/modules/settings/device-limit.service', () => ({
  getMaxDevicesForRole: async () => limit,
}));
vi.mock('@/modules/ws/ws.service', () => ({
  disconnectMemberConnections: vi.fn(async () => {}),
}));
vi.mock('@/core/prisma/client', () => ({
  prisma: {
    session: {
      findMany: async ({ where }: { where: { memberId: string; NOT: { deviceId: string } } }) =>
        rows
          .filter((r) => r.memberId === where.memberId && r.deviceId !== where.NOT.deviceId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((r) => ({ id: r.id })),
      count: async ({ where }: { where: { memberId: string } }) => rows.filter((r) => r.memberId === where.memberId).length,
      findFirst: async ({ where }: { where: { memberId: string } }) =>
        rows.filter((r) => r.memberId === where.memberId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
      delete: async ({ where }: { where: { id: string } }) => {
        rows = rows.filter((r) => r.id !== where.id);
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        rows = rows.filter((r) => !where.id.in.includes(r.id));
      },
      findUnique: async ({ where }: { where: { memberId_deviceId: { memberId: string; deviceId: string } } }) =>
        rows.find(
          (r) => r.memberId === where.memberId_deviceId.memberId && r.deviceId === where.memberId_deviceId.deviceId,
        ) ?? null,
      update: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id),
      create: async ({ data }: { data: { memberId: string; deviceId: string } }) => {
        const row = { id: `s${++seq}`, memberId: data.memberId, deviceId: data.deviceId, createdAt: new Date(seq * 1000) };
        rows.push(row);
        return row;
      },
    },
  },
}));

const { upsertDeviceSession } = await import('./session.service');

const devicesOf = (memberId: string) => rows.filter((r) => r.memberId === memberId).map((r) => r.deviceId).sort();
const login = (deviceId: string) => upsertDeviceSession('m1', 'BIDDER', deviceId, {});
const seed = (...deviceIds: string[]) => {
  for (const deviceId of deviceIds) rows.push({ id: `s${++seq}`, memberId: 'm1', deviceId, createdAt: new Date(seq * 1000) });
};

describe('upsertDeviceSession', () => {
  beforeEach(() => {
    rows = [];
    seq = 0;
    limit = 1;
  });

  it('limit 1: a second device logs the first one out', async () => {
    await login('A');
    await login('B');
    expect(devicesOf('m1')).toEqual(['B']);
  });

  it('limit 1 set while 2 devices are open: next new-device login leaves only 1', async () => {
    seed('A', 'B'); // opened while the limit was higher
    await login('C');
    expect(devicesOf('m1')).toEqual(['C']);
  });

  it('limit 1 set while 2 devices are open: re-login on a known device also trims', async () => {
    seed('A', 'B');
    await login('A');
    expect(devicesOf('m1')).toEqual(['A']);
  });

  it('limit 2: third device evicts only the oldest', async () => {
    limit = 2;
    await login('A');
    await login('B');
    await login('C');
    expect(devicesOf('m1')).toEqual(['B', 'C']);
  });

  it('re-login on a known device within the limit keeps everything', async () => {
    limit = 2;
    await login('A');
    await login('B');
    await login('A');
    expect(devicesOf('m1')).toEqual(['A', 'B']);
  });

  it('never touches another member', async () => {
    rows.push({ id: 'x', memberId: 'm2', deviceId: 'Z', createdAt: new Date(0) });
    await login('A');
    await login('B');
    expect(devicesOf('m2')).toEqual(['Z']);
  });
});
