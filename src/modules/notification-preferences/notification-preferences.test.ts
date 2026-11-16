import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  notificationPreference: { findMany: vi.fn(), upsert: vi.fn((a: unknown) => a) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));

import { getPreferences, updatePreferences } from './notification-preferences.service';
import { updatePreferencesSchema } from './notification-preferences.validation';
import { NOTIFY_CATALOGUE, isMandatoryEmail, resolveChannels } from '@/modules/notify/notify.catalogue';
import { NOTIFY_TYPES } from '@/modules/notify/notify.types';

const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e) => `${e.statusCode}:${e.code}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  db.notificationPreference.findMany.mockResolvedValue([]);
});

describe('catalogue', () => {
  it('covers every notify type with a label and group', () => {
    for (const t of NOTIFY_TYPES) expect(NOTIFY_CATALOGUE[t]).toMatchObject({ label: expect.any(String), group: expect.any(String) });
  });
  it('mandatory email set', () => {
    for (const t of ['sale-paid', 'deposit-held', 'commission-due', 'commission-paid', 'strike-issued', 'account-suspended', 'auction-won', 'second-chance-offer']) {
      expect(isMandatoryEmail(t)).toBe(true);
    }
    for (const t of ['outbid', 'ending-soon', 'saved-search-match', 'followed-seller-listed', 'auction-sold']) expect(isMandatoryEmail(t)).toBe(false);
  });
  it('resolveChannels: defaults, stored prefs, mandatory email', () => {
    expect(resolveChannels({ type: 'outbid', pref: null })).toEqual({ email: true, push: true });
    expect(resolveChannels({ type: 'outbid', pref: { email: false, push: false } })).toEqual({ email: false, push: false });
    expect(resolveChannels({ type: 'auction-won', pref: { email: false } }).email).toBe(true);
  });
});

describe('GET preferences', () => {
  it('returns defaults for a missing row, with email locks and no WhatsApp fields', async () => {
    const res = await getPreferences('m1', 'MEMBER');
    const outbid = res.items.find((i) => i.type === 'outbid');
    expect(outbid).toEqual({ type: 'outbid', label: expect.any(String), group: 'Bidding', email: true, push: true, emailLocked: false });
    expect(res.items.find((i) => i.type === 'sale-paid')).toMatchObject({ emailLocked: true });
    expect(Object.keys(res)).toEqual(['items']);
  });

  it('hides admin-only types from non-admins and shows them to SUPER_ADMIN', async () => {
    expect((await getPreferences('m1', 'MEMBER')).items.map((i) => i.type)).not.toContain('shill-flag');
    const admin = (await getPreferences('a1', 'SUPER_ADMIN')).items.map((i) => i.type);
    expect(admin).toEqual(expect.arrayContaining(['shill-flag', 'report-filed']));
  });

  it('applies stored rows', async () => {
    db.notificationPreference.findMany.mockResolvedValue([{ type: 'outbid', email: false, push: false }]);
    const res = await getPreferences('m1', 'MEMBER');
    expect(res.items.find((i) => i.type === 'outbid')).toMatchObject({ email: false, push: false });
  });
});

describe('PUT preferences', () => {
  it('schema rejects unknown types, duplicates, empty and non-boolean', () => {
    const ok = { type: 'outbid', email: true, push: true };
    expect(updatePreferencesSchema.validate({ items: [ok] }).error).toBeUndefined();
    expect(updatePreferencesSchema.validate({ items: [{ ...ok, type: 'nope' }] }).error).toBeDefined();
    expect(updatePreferencesSchema.validate({ items: [ok, ok] }).error).toBeDefined();
    expect(updatePreferencesSchema.validate({ items: [] }).error).toBeDefined();
    expect(updatePreferencesSchema.validate({ items: [{ ...ok, push: 'x' }] }).error).toBeDefined();
  });

  it('ignores email = false on a mandatory type', async () => {
    await updatePreferences('m1', 'MEMBER', [
      { type: 'sale-paid', email: false, push: false },
      { type: 'outbid', email: false, push: true },
    ]);
    const ups = db.notificationPreference.upsert.mock.calls.map((c) => c[0] as { create: Record<string, unknown>; where: unknown });
    expect(ups[0].create).toMatchObject({ type: 'sale-paid', email: true, push: false });
    expect(ups[1].create).toMatchObject({ type: 'outbid', email: false, push: true });
    expect(ups[1].where).toEqual({ memberId_type: { memberId: 'm1', type: 'outbid' } });
  });

  it('an admin-only type from a non-admin is a 400', async () => {
    expect(await code(updatePreferences('m1', 'MEMBER', [{ type: 'shill-flag', email: true, push: true }]))).toBe('400:BAD_REQUEST');
    expect(db.notificationPreference.upsert).not.toHaveBeenCalled();
  });
});
