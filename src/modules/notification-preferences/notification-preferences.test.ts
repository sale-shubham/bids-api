import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  notificationPreference: { findMany: vi.fn(), upsert: vi.fn((a: unknown) => a) },
  member: { findUnique: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/modules/auth/otp-challenge.service', () => ({ issueOtpChallenge: vi.fn(), consumeOtpChallenge: vi.fn(async () => undefined) }));
vi.mock('@/modules/members/verification.service', () => ({ refreshSellerVerification: vi.fn(async () => false) }));

import { getPreferences, setWhatsappOptIn, updatePreferences } from './notification-preferences.service';
import { updatePreferencesSchema, whatsappOptSchema } from './notification-preferences.validation';
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
  db.member.findUnique.mockResolvedValue({ whatsappOptInAt: null, phoneVerifiedAt: null });
});

describe('catalogue', () => {
  it('covers every notify type with a label and group', () => {
    for (const t of NOTIFY_TYPES) expect(NOTIFY_CATALOGUE[t]).toMatchObject({ label: expect.any(String), group: expect.any(String) });
  });
  it('WhatsApp-capable types are exactly outbid, ending-soon, auction-won', () => {
    expect(NOTIFY_TYPES.filter((t) => NOTIFY_CATALOGUE[t].whatsappCapable)).toEqual(['outbid', 'auction-won', 'ending-soon'].sort((a, b) => NOTIFY_TYPES.indexOf(a as never) - NOTIFY_TYPES.indexOf(b as never)));
  });
  it('mandatory email set', () => {
    for (const t of ['sale-paid', 'deposit-held', 'commission-due', 'commission-paid', 'strike-issued', 'account-suspended', 'auction-won', 'second-chance-offer']) {
      expect(isMandatoryEmail(t)).toBe(true);
    }
    for (const t of ['outbid', 'ending-soon', 'saved-search-match', 'followed-seller-listed', 'auction-sold']) expect(isMandatoryEmail(t)).toBe(false);
  });
  it('resolveChannels: defaults, mandatory email, whatsapp gating', () => {
    const base = { whatsappOptIn: true, phoneVerified: true };
    expect(resolveChannels({ type: 'outbid', pref: null, ...base })).toEqual({ email: true, push: true, whatsapp: false });
    expect(resolveChannels({ type: 'outbid', pref: { email: false, push: false, whatsapp: true }, ...base })).toEqual({ email: false, push: false, whatsapp: true });
    expect(resolveChannels({ type: 'auction-won', pref: { email: false }, ...base }).email).toBe(true);
    expect(resolveChannels({ type: 'outbid', pref: { whatsapp: true }, whatsappOptIn: false, phoneVerified: true }).whatsapp).toBe(false);
    expect(resolveChannels({ type: 'outbid', pref: { whatsapp: true }, whatsappOptIn: true, phoneVerified: false }).whatsapp).toBe(false);
    expect(resolveChannels({ type: 'review-received', pref: { whatsapp: true }, ...base }).whatsapp).toBe(false);
  });
});

describe('GET preferences', () => {
  it('returns defaults for a missing row, with locks and capability flags', async () => {
    const res = await getPreferences('m1', 'BIDDER');
    const outbid = res.items.find((i) => i.type === 'outbid');
    expect(outbid).toEqual({ type: 'outbid', label: expect.any(String), group: 'Bidding', email: true, push: true, whatsapp: false, emailLocked: false, whatsappCapable: true });
    expect(res.items.find((i) => i.type === 'sale-paid')).toMatchObject({ emailLocked: true, whatsappCapable: false });
    expect(res).toMatchObject({ whatsappOptIn: false, phoneVerified: false });
  });

  it('hides admin-only types from non-admins and shows them to SUPER_ADMIN', async () => {
    expect((await getPreferences('m1', 'AUCTIONEER')).items.map((i) => i.type)).not.toContain('shill-flag');
    const admin = (await getPreferences('a1', 'SUPER_ADMIN')).items.map((i) => i.type);
    expect(admin).toEqual(expect.arrayContaining(['shill-flag', 'report-filed']));
  });

  it('applies stored rows and reports opt-in / phone state', async () => {
    db.notificationPreference.findMany.mockResolvedValue([{ type: 'outbid', email: false, push: false, whatsapp: true }]);
    db.member.findUnique.mockResolvedValue({ whatsappOptInAt: new Date(), phoneVerifiedAt: new Date() });
    const res = await getPreferences('m1', 'BIDDER');
    expect(res.items.find((i) => i.type === 'outbid')).toMatchObject({ email: false, push: false, whatsapp: true });
    expect(res).toMatchObject({ whatsappOptIn: true, phoneVerified: true });
  });
});

describe('PUT preferences', () => {
  it('schema rejects unknown types, duplicates, empty and non-boolean', () => {
    const ok = { type: 'outbid', email: true, push: true, whatsapp: false };
    expect(updatePreferencesSchema.validate({ items: [ok] }).error).toBeUndefined();
    expect(updatePreferencesSchema.validate({ items: [{ ...ok, type: 'nope' }] }).error).toBeDefined();
    expect(updatePreferencesSchema.validate({ items: [ok, ok] }).error).toBeDefined();
    expect(updatePreferencesSchema.validate({ items: [] }).error).toBeDefined();
    expect(updatePreferencesSchema.validate({ items: [{ ...ok, push: 'x' }] }).error).toBeDefined();
  });

  it('ignores email = false on a mandatory type and whatsapp on a non-capable type', async () => {
    await updatePreferences('m1', 'BIDDER', [
      { type: 'sale-paid', email: false, push: false, whatsapp: true },
      { type: 'outbid', email: false, push: true, whatsapp: true },
    ]);
    const ups = db.notificationPreference.upsert.mock.calls.map((c) => c[0] as { create: Record<string, unknown>; where: unknown });
    expect(ups[0].create).toMatchObject({ type: 'sale-paid', email: true, push: false, whatsapp: false });
    expect(ups[1].create).toMatchObject({ type: 'outbid', email: false, push: true, whatsapp: true });
    expect(ups[1].where).toEqual({ memberId_type: { memberId: 'm1', type: 'outbid' } });
  });

  it('an admin-only type from a non-admin is a 400', async () => {
    expect(await code(updatePreferences('m1', 'BIDDER', [{ type: 'shill-flag', email: true, push: true, whatsapp: false }]))).toBe('400:BAD_REQUEST');
    expect(db.notificationPreference.upsert).not.toHaveBeenCalled();
  });
});

describe('WhatsApp opt-in', () => {
  it('needs a verified phone (409 PHONE_NOT_VERIFIED)', async () => {
    expect(await code(setWhatsappOptIn('m1', true))).toBe('409:PHONE_NOT_VERIFIED');
    expect(db.member.update).not.toHaveBeenCalled();
  });
  it('opts in with a verified phone and opts out freely', async () => {
    db.member.findUnique.mockResolvedValue({ phoneVerifiedAt: new Date() });
    const now = new Date('2026-11-16T00:00:00Z');
    expect(await setWhatsappOptIn('m1', true, now)).toEqual({ whatsappOptIn: true });
    expect(db.member.update).toHaveBeenLastCalledWith({ where: { id: 'm1' }, data: { whatsappOptInAt: now } });
    db.member.findUnique.mockResolvedValue({ phoneVerifiedAt: null });
    expect(await setWhatsappOptIn('m1', false)).toEqual({ whatsappOptIn: false });
    expect(db.member.update).toHaveBeenLastCalledWith({ where: { id: 'm1' }, data: { whatsappOptInAt: null } });
  });
  it('body schema needs a boolean', () => {
    expect(whatsappOptSchema.validate({}).error).toBeDefined();
    expect(whatsappOptSchema.validate({ optIn: 'x' }).error).toBeDefined();
    expect(whatsappOptSchema.validate({ optIn: true }).error).toBeUndefined();
  });
});

describe('verifying a different phone clears the opt-in', () => {
  it('clears whatsappOptInAt when the number changes, keeps it when re-verifying the same one', async () => {
    const { verifyPhone } = await import('@/modules/members/phone.service');
    db.member.findUnique.mockResolvedValue({ phone: '9876543210' });
    await verifyPhone('m1', '9123456789', '123456');
    expect(db.member.update.mock.calls[0][0].data).toMatchObject({ phone: '9123456789', whatsappOptInAt: null });
    await verifyPhone('m1', '9876543210', '123456');
    expect(db.member.update.mock.calls[1][0].data).not.toHaveProperty('whatsappOptInAt');
  });
});
