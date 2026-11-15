import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const d: any = {
    invoice: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    invoiceCounter: { upsert: vi.fn() },
    member: { findUnique: vi.fn(), update: vi.fn() },
    appSetting: { findMany: vi.fn() },
    commission: { findUnique: vi.fn() },
    featurePurchase: { findUnique: vi.fn() },
    auctionDeposit: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
  };
  d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d));
  return d;
});
const storage = vi.hoisted(() => ({ putObject: vi.fn(async () => undefined), presignGet: vi.fn(async (k: string, s: number) => `https://signed.test/${k}?exp=${s}`) }));
const enqueue = vi.hoisted(() => vi.fn(async (_m: unknown) => undefined));

vi.mock('@/core/prisma/client', () => ({ prisma: db }));
vi.mock('@/core/logger/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/providers/storage', () => ({ storage }));
vi.mock('@/modules/notify/notify.queue', () => ({ enqueueNotification: enqueue }));
vi.mock('@/core/config/env', () => ({ env: { storage: { cdnBaseUrl: 'https://cdn.test', s3: { bucket: '', region: 'ap-south-1' } }, twoFactor: { requireAdmin: false } } }));

import { Prisma } from '@prisma/client';
import { amountInWords, computeInvoiceTax, financialYearOf, gstinMatchesState, invoiceNumber } from './invoice.rules';
import { renderInvoicePdf } from './invoice.pdf';
import { getPdfUrl, issueCommissionInvoice, issueDepositForfeitInvoice, issueFeatureInvoice, issueInvoice } from './invoices.service';
import { invoiceSettingsSchema } from './invoices.validation';
import { setInvoiceSettings } from './invoice.settings';
import { updateMeSchema } from '@/modules/members/members.validation';
import { updateProfile } from '@/modules/members/members.service';

const GSTIN = '27ABCDE1234F1Z5';
const base = { platformGstin: GSTIN, platformStateCode: '27', buyerState: '27', gstRateBps: 1800, inclusive: true };

const settingRows = (over: Record<string, string> = {}) =>
  Object.entries({ 'invoice.legalName': 'NobleBid Pvt Ltd', 'invoice.gstin': GSTIN, 'invoice.address': 'Mumbai', 'invoice.stateCode': '27', ...over }).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.appSetting.findMany.mockResolvedValue(settingRows());
  db.invoice.findUnique.mockResolvedValue(null);
  db.member.findUnique.mockResolvedValue({ name: 'Asha', gstin: null, billingState: null });
  db.$queryRaw.mockResolvedValue([{ seq: 7 }]);
  db.invoice.create.mockImplementation(async ({ data }: { data: { number: string } }) => ({ id: 'inv1', number: data.number }));
});

describe('financial year + numbering', () => {
  it('31 Mar vs 1 Apr in IST (not UTC)', () => {
    expect(financialYearOf(new Date('2027-03-31T12:00:00+05:30'))).toBe('2026-27');
    expect(financialYearOf(new Date('2027-04-01T00:00:00+05:30'))).toBe('2027-28');
    // 31 Mar 20:00 UTC is already 1 Apr 01:30 IST
    expect(financialYearOf(new Date('2027-03-31T20:00:00Z'))).toBe('2027-28');
    expect(financialYearOf(new Date('2026-11-16T10:00:00Z'))).toBe('2026-27');
    expect(financialYearOf(new Date('2099-12-31T10:00:00Z'))).toBe('2099-00');
  });
  it('number format NB/<FY>/<6-digit seq>', () => {
    expect(invoiceNumber('2026-27', 42)).toBe('NB/2026-27/000042');
  });
  it('issuing numbers inside one transaction from the FY counter row', async () => {
    const r = await issueInvoice({ type: 'FEATURE', refId: 'fp1', memberId: 'm1', totalPaise: 11_800 }, new Date('2027-04-01T00:30:00+05:30'));
    expect(r).toEqual({ id: 'inv1', number: 'NB/2027-28/000007', created: true });
    expect(db.invoiceCounter.upsert.mock.calls[0][0].where).toEqual({ financialYear: '2027-28' });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ financialYear: '2027-28', seq: 7, isTaxInvoice: true, totalPaise: 11_800n, taxablePaise: 10_000n, cgstPaise: 900n, sgstPaise: 900n, igstPaise: 0n });
  });
});

describe('computeInvoiceTax', () => {
  it('inclusive intra-state: CGST + SGST, taxable = round(total x 10000 / 11800)', () => {
    expect(computeInvoiceTax({ ...base, totalPaise: 11_800 })).toEqual({ isTaxInvoice: true, taxablePaise: 10_000, cgstPaise: 900, sgstPaise: 900, igstPaise: 0, totalPaise: 11_800 });
  });
  it('inter-state: all tax in IGST', () => {
    expect(computeInvoiceTax({ ...base, buyerState: '29', totalPaise: 11_800 })).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 1_800 });
  });
  it('odd paisa goes to SGST', () => {
    const t = computeInvoiceTax({ ...base, totalPaise: 9_999 });
    expect(t.taxablePaise + t.cgstPaise + t.sgstPaise).toBe(9_999);
    expect(t.cgstPaise + t.sgstPaise).toBe(9_999 - t.taxablePaise);
    const odd = computeInvoiceTax({ ...base, totalPaise: 100 });
    expect(odd).toMatchObject({ taxablePaise: 85, cgstPaise: 7, sgstPaise: 8 });
  });
  it('unknown buyer state counts as intra-state', () => {
    expect(computeInvoiceTax({ ...base, buyerState: null, totalPaise: 11_800 }).igstPaise).toBe(0);
  });
  it('no platform GSTIN: a receipt with no tax', () => {
    expect(computeInvoiceTax({ ...base, platformGstin: null, totalPaise: 11_800 })).toEqual({ isTaxInvoice: false, taxablePaise: 11_800, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 11_800 });
  });
  it('exclusive mode adds tax on top (display of new prices only)', () => {
    expect(computeInvoiceTax({ ...base, inclusive: false, totalPaise: 10_000 })).toMatchObject({ taxablePaise: 10_000, cgstPaise: 900, sgstPaise: 900, totalPaise: 11_800 });
  });
  it('issuance always treats charged amounts as inclusive even if the setting says exclusive', async () => {
    db.appSetting.findMany.mockResolvedValue(settingRows({ 'invoice.commissionInclusive': 'false' }));
    await issueInvoice({ type: 'COMMISSION', refId: 'c1', memberId: 'm1', totalPaise: 11_800 });
    expect(db.invoice.create.mock.calls[0][0].data.totalPaise).toBe(11_800n);
  });
  it('buyer in another state gets IGST on the stored invoice', async () => {
    db.member.findUnique.mockResolvedValue({ name: 'B', gstin: '29ABCDE1234F1Z5', billingState: '29' });
    await issueInvoice({ type: 'COMMISSION', refId: 'c1', memberId: 'm1', totalPaise: 11_800 });
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ igstPaise: 1_800n, cgstPaise: 0n, buyerGstin: '29ABCDE1234F1Z5', placeOfSupply: '29' });
  });
});

describe('idempotent issuance', () => {
  it('an existing invoice for (type, refId) is returned, nothing numbered', async () => {
    db.invoice.findUnique.mockResolvedValue({ id: 'old', number: 'NB/2026-27/000001' });
    expect(await issueInvoice({ type: 'COMMISSION', refId: 'c1', memberId: 'm1', totalPaise: 100 })).toEqual({ id: 'old', number: 'NB/2026-27/000001', created: false });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('a unique-violation race returns the winner', async () => {
    db.invoice.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'won', number: 'NB/2026-27/000002' });
    db.invoice.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    expect(await issueInvoice({ type: 'FEATURE', refId: 'fp1', memberId: 'm1', totalPaise: 100 })).toMatchObject({ id: 'won', created: false });
  });
  it('commission hook: only PAID commissions; failures never throw', async () => {
    db.commission.findUnique.mockResolvedValue({ id: 'c1', sellerId: 's1', amountPaise: 5_000n, status: 'DUE' });
    await issueCommissionInvoice('c1');
    expect(db.invoice.create).not.toHaveBeenCalled();
    db.commission.findUnique.mockResolvedValue({ id: 'c1', sellerId: 's1', amountPaise: 5_000n, status: 'PAID' });
    await issueCommissionInvoice('c1');
    expect(db.invoice.create.mock.calls[0][0].data).toMatchObject({ type: 'COMMISSION', refId: 'c1', memberId: 's1' });
    expect(enqueue).not.toHaveBeenCalled(); // commission-paid already carries the invoice link
    db.commission.findUnique.mockRejectedValue(new Error('db down'));
    await expect(issueCommissionInvoice('c1')).resolves.toBeUndefined();
  });
  it('feature and deposit-forfeit hooks issue and send invoice-issued', async () => {
    db.featurePurchase.findUnique.mockResolvedValue({ id: 'fp1', sellerId: 's1', auctionId: 'a1', amountPaise: 9_900n, status: 'PAID' });
    await issueFeatureInvoice('fp1');
    db.auctionDeposit.findUnique.mockResolvedValue({ id: 'd1', memberId: 'b1', auctionId: 'a1', amountPaise: 50_000n, status: 'FORFEITED' });
    await issueDepositForfeitInvoice('d1');
    expect(db.invoice.create.mock.calls.map((c: any[]) => c[0].data.type)).toEqual(['FEATURE', 'DEPOSIT_FORFEIT']);
    expect(enqueue.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['invoice-issued', 'invoice-issued']);
  });
});

describe('amount in words (Indian numbering)', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [11_800, 'Rupees One Hundred Eighteen Only'],
    [12_345_650, 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only'],
    [250_000_000, 'Rupees Twenty Five Lakh Only'],
    [10_000_000_000, 'Rupees Ten Crore Only'],
  ])('%i paise', (paise, words) => expect(amountInWords(paise)).toBe(words));
});

describe('PDF', () => {
  const data = {
    number: 'NB/2026-27/000001',
    issuedAt: new Date('2026-11-16T10:00:00Z'),
    isTaxInvoice: true,
    platform: { legalName: 'NobleBid', gstin: GSTIN, address: 'Mumbai', stateCode: '27' },
    buyer: { name: 'Asha', gstin: null, state: '27', placeOfSupply: '27' },
    description: 'Platform commission for auction "Watch"',
    sacCode: '998599',
    gstRateBps: 1800,
    taxablePaise: 10_000,
    cgstPaise: 900,
    sgstPaise: 900,
    igstPaise: 0,
    totalPaise: 11_800,
  };
  it('renders a PDF buffer (tax invoice and receipt)', async () => {
    const a = await renderInvoicePdf(data);
    expect(Buffer.isBuffer(a)).toBe(true);
    expect(a.subarray(0, 4).toString()).toBe('%PDF');
    const b = await renderInvoicePdf({ ...data, isTaxInvoice: false, cgstPaise: 0, sgstPaise: 0, taxablePaise: 11_800 });
    expect(b.subarray(0, 4).toString()).toBe('%PDF');
  });

  const inv = {
    id: 'inv1', number: 'NB/2026-27/000001', financialYear: '2026-27', type: 'COMMISSION', refId: 'c1', memberId: 'owner', buyerName: 'Asha', buyerGstin: null, buyerState: '27',
    placeOfSupply: '27', taxablePaise: 10_000n, cgstPaise: 900n, sgstPaise: 900n, igstPaise: 0n, totalPaise: 11_800n, isTaxInvoice: true, issuedAt: new Date('2026-11-16T10:00:00Z'), pdfKey: null,
  };
  it('owner: renders once, stores privately under invoices/<FY>/<id>.pdf, returns a 5-minute presigned URL', async () => {
    db.invoice.findUnique.mockResolvedValue(inv);
    db.commission.findUnique.mockResolvedValue({ auction: { title: 'Watch' } });
    const r = await getPdfUrl({ sub: 'owner', role: 'AUCTIONEER' }, 'inv1');
    expect(r).toEqual({ url: 'https://signed.test/invoices/2026-27/inv1.pdf?exp=300' });
    expect(storage.putObject).toHaveBeenCalledTimes(1);
    const [key, body, type] = storage.putObject.mock.calls[0] as unknown as [string, Buffer, string];
    expect([key, type, body.subarray(0, 4).toString()]).toEqual(['invoices/2026-27/inv1.pdf', 'application/pdf', '%PDF']);
    expect(db.invoice.update).toHaveBeenCalledWith({ where: { id: 'inv1' }, data: { pdfKey: 'invoices/2026-27/inv1.pdf' } });
  });
  it('second request reuses the stored PDF', async () => {
    db.invoice.findUnique.mockResolvedValue({ ...inv, pdfKey: 'invoices/2026-27/inv1.pdf' });
    await getPdfUrl({ sub: 'owner', role: 'AUCTIONEER' }, 'inv1');
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(storage.presignGet).toHaveBeenCalledWith('invoices/2026-27/inv1.pdf', 300);
  });
  it('another member gets 404; SUPER_ADMIN may read; unknown id 404', async () => {
    db.invoice.findUnique.mockResolvedValue({ ...inv, pdfKey: 'k' });
    await expect(getPdfUrl({ sub: 'stranger', role: 'AUCTIONEER' }, 'inv1')).rejects.toMatchObject({ statusCode: 404, code: 'INVOICE_NOT_FOUND' });
    await expect(getPdfUrl({ sub: 'admin', role: 'SUPER_ADMIN' }, 'inv1')).resolves.toHaveProperty('url');
    db.invoice.findUnique.mockResolvedValue(null);
    await expect(getPdfUrl({ sub: 'owner', role: 'AUCTIONEER' }, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('GSTIN validation', () => {
  it('schema: valid GSTIN passes (uppercased), malformed fails, empty clears', () => {
    expect(updateMeSchema.validate({ gstin: GSTIN.toLowerCase(), billingState: '27' }).value).toMatchObject({ gstin: GSTIN });
    expect(updateMeSchema.validate({ gstin: 'NOTAGSTIN' }).error).toBeDefined();
    expect(updateMeSchema.validate({ billingState: '99' }).error).toBeDefined();
    expect(updateMeSchema.validate({ gstin: '', billingState: null }).error).toBeUndefined();
    expect(gstinMatchesState(GSTIN, '27')).toBe(true);
    expect(gstinMatchesState(GSTIN, '29')).toBe(false);
    expect(gstinMatchesState(GSTIN, null)).toBe(true);
  });
  it('PATCH /members/me: first two GSTIN digits must equal billingState -> 400 INVALID_GSTIN', async () => {
    await expect(updateProfile('m1', { gstin: GSTIN, billingState: '29' })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_GSTIN' });
    db.member.findUnique.mockResolvedValue({ gstin: null, billingState: '29' });
    await expect(updateProfile('m1', { gstin: GSTIN })).rejects.toMatchObject({ code: 'INVALID_GSTIN' });
    expect(db.member.update).not.toHaveBeenCalled();
  });
  it('PATCH /members/me: a matching pair is saved', async () => {
    db.member.update.mockResolvedValue({ id: 'm1', unpaidCommissionPaise: 0n, moneySpentPaise: 0n, twoFactorEnabledAt: null, verifiedAt: null, whatsappOptInAt: null });
    await updateProfile('m1', { gstin: GSTIN, billingState: '27' });
    expect(db.member.update.mock.calls[0][0].data).toEqual({ gstin: GSTIN, billingState: '27' });
  });
  it('admin invoice settings: gstin format and state match', async () => {
    const ok = { legalName: 'NobleBid', gstin: GSTIN, address: 'Mumbai', stateCode: '27', gstRateBps: 1800, commissionInclusive: true, sacCode: '998599' };
    expect(invoiceSettingsSchema.validate(ok).error).toBeUndefined();
    expect(invoiceSettingsSchema.validate({ ...ok, gstin: 'bad' }).error).toBeDefined();
    expect(invoiceSettingsSchema.validate({ ...ok, gstin: '' }).error).toBeUndefined();
    await expect(setInvoiceSettings({ ...ok, stateCode: '29' })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_GSTIN' });
  });
});
