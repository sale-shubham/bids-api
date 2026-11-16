import { bearer, getApp, prismaMock, resetPrismaMock } from './harness';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('@/core/prisma/client', async () => ({ prisma: (await import('./harness')).prismaMock }));
vi.mock('@/core/middleware/pgRateLimitStore', async () => ({ PgRateLimitStore: (await import('./harness')).PassStore }));
vi.mock('@/core/logger/logger', async () => ({ logger: (await import('./harness')).silentLogger }));

// A real PDF is rendered (pdfkit); storage is mocked only to prove it is never touched.
const storage = vi.hoisted(() => ({ putObject: vi.fn(), presignGet: vi.fn() }));
vi.mock('@/providers/storage', () => ({ storage }));

const inv = {
  id: 'inv1', number: 'NB/2026-27/000001', financialYear: '2026-27', type: 'COMMISSION', refId: 'c1', memberId: 'owner', buyerName: 'Asha', buyerGstin: null, buyerState: '27',
  placeOfSupply: '27', taxablePaise: 10_000n, cgstPaise: 900n, sgstPaise: 900n, igstPaise: 0n, totalPaise: 11_800n, isTaxInvoice: true, issuedAt: new Date('2026-11-16T10:00:00Z'), pdfKey: null,
};

const get = async (as: 'MEMBER' | 'SUPER_ADMIN', id: string) =>
  request(await getApp())
    .get('/invoices/inv1/pdf')
    .set('Authorization', await bearer(as, id))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

beforeEach(() => {
  resetPrismaMock();
  storage.putObject.mockReset();
  storage.presignGet.mockReset();
  prismaMock.invoice.findUnique.mockResolvedValue(inv);
  prismaMock.commission.findUnique.mockResolvedValue({ auction: { title: 'Watch' } });
  prismaMock.appSetting.findMany.mockResolvedValue([]);
});

describe('GET /invoices/:id/pdf', () => {
  it('owner: 200 streams application/pdf with the filename, length and no-store headers', async () => {
    const res = await get('MEMBER', 'owner');
    const body = res.body as Buffer;
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="NB-2026-27-000001.pdf"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Number(res.headers['content-length'])).toBe(body.length);
    expect(body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('renders on every request: no storage writes, no presign, pdfKey untouched', async () => {
    await get('MEMBER', 'owner');
    await get('MEMBER', 'owner');
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(storage.presignGet).not.toHaveBeenCalled();
    expect(prismaMock.invoice.update).not.toHaveBeenCalled();
    expect(prismaMock.commission.findUnique).toHaveBeenCalledTimes(2);
  });

  it('another member: JSON 404 INVOICE_NOT_FOUND', async () => {
    const res = await request(await getApp())
      .get('/invoices/inv1/pdf')
      .set('Authorization', await bearer('MEMBER', 'stranger'));
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ success: false, error: { code: 'INVOICE_NOT_FOUND' } });
  });

  it('unknown invoice: JSON 404', async () => {
    prismaMock.invoice.findUnique.mockResolvedValue(null);
    const res = await request(await getApp())
      .get('/invoices/inv1/pdf')
      .set('Authorization', await bearer('MEMBER', 'owner'));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('INVOICE_NOT_FOUND');
  });

  it('SUPER_ADMIN: 200 PDF for any invoice', async () => {
    const res = await get('SUPER_ADMIN', 'admin1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});
