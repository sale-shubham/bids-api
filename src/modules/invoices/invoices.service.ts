import { Prisma } from '@prisma/client';
import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { toPaise } from '@/core/money';
import { offsetArgs, pageMeta } from '@/core/http/pagination';
import { bestEffort } from '@/core/best-effort';
import { enqueueNotification } from '@/modules/notify/notify.queue';
import { computeInvoiceTax, financialYearOf, invoiceDescription, invoiceNumber, type InvoiceTypeValue } from './invoice.rules';
import { getInvoiceSettings } from './invoice.settings';
import type { AdminListQuery, MineQuery } from './invoices.validation';

type InvoiceRow = {
  id: string;
  number: string;
  type: InvoiceTypeValue;
  totalPaise: bigint | number;
  isTaxInvoice: boolean;
  issuedAt: Date;
};

export const toInvoiceDTO = (i: InvoiceRow) => ({
  id: i.id,
  number: i.number,
  type: i.type,
  totalPaise: toPaise(i.totalPaise),
  isTaxInvoice: i.isTaxInvoice,
  issuedAt: i.issuedAt,
});

const invoiceNotFound = () => new AppError(404, 'INVOICE_NOT_FOUND', 'Invoice not found');

export type IssueInput = { type: InvoiceTypeValue; refId: string; memberId: string; totalPaise: number };

/**
 * Issue one invoice, idempotent on (type, refId). Numbering runs in the same transaction as the insert, so a
 * duplicate (unique violation) rolls the counter back too. Amounts already charged are ALWAYS GST-inclusive
 * (the `invoice.commissionInclusive` setting is display-only, see decision D15).
 */
export async function issueInvoice(input: IssueInput, now = new Date()): Promise<{ id: string; number: string; created: boolean }> {
  const existing = await prisma.invoice.findUnique({ where: { type_refId: { type: input.type, refId: input.refId } }, select: { id: true, number: true } });
  if (existing) return { ...existing, created: false };

  const [settings, member] = await Promise.all([
    getInvoiceSettings(),
    prisma.member.findUnique({ where: { id: input.memberId }, select: { name: true, gstin: true, billingState: true } }),
  ]);
  if (!member) throw new AppError(404, 'MEMBER_NOT_FOUND', 'Member not found');
  const tax = computeInvoiceTax({
    totalPaise: input.totalPaise,
    platformGstin: settings.gstin,
    platformStateCode: settings.stateCode,
    buyerState: member.billingState,
    gstRateBps: settings.gstRateBps,
    inclusive: true,
  });
  const fy = financialYearOf(now);

  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.invoiceCounter.upsert({ where: { financialYear: fy }, create: { financialYear: fy, seq: 0 }, update: {} });
      const rows = await tx.$queryRaw<{ seq: number }[]>`UPDATE "InvoiceCounter" SET "seq" = "seq" + 1 WHERE "financialYear" = ${fy} RETURNING "seq"`;
      const seq = Number(rows[0].seq);
      return tx.invoice.create({
        data: {
          number: invoiceNumber(fy, seq),
          financialYear: fy,
          seq,
          type: input.type,
          refId: input.refId,
          memberId: input.memberId,
          buyerName: member.name,
          buyerGstin: member.gstin,
          buyerState: member.billingState,
          placeOfSupply: member.billingState ?? settings.stateCode,
          taxablePaise: BigInt(tax.taxablePaise),
          cgstPaise: BigInt(tax.cgstPaise),
          sgstPaise: BigInt(tax.sgstPaise),
          igstPaise: BigInt(tax.igstPaise),
          totalPaise: BigInt(tax.totalPaise),
          isTaxInvoice: tax.isTaxInvoice,
          issuedAt: now,
        },
        select: { id: true, number: true },
      });
    });
    return { ...created, created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const dup = await prisma.invoice.findUnique({ where: { type_refId: { type: input.type, refId: input.refId } }, select: { id: true, number: true } });
      if (dup) return { ...dup, created: false };
    }
    throw err;
  }
}

async function announce(type: InvoiceTypeValue, issued: { id: string; number: string; created: boolean }, memberId: string, totalPaise: number, auctionId?: string) {
  if (!issued.created || type === 'COMMISSION') return;
  await enqueueNotification({
    type: 'invoice-issued',
    memberId,
    auctionId,
    data: { invoiceId: issued.id, invoiceNumber: issued.number, invoiceType: type, totalPaise },
    dedupeKey: `invoice-issued:${issued.id}`,
  });
}

/** Best-effort hooks, called after the payment effect committed. Never throw. */
export const issueCommissionInvoice = (commissionId: string, now = new Date()) =>
  bestEffort(
    'invoice: commission',
    async () => {
      const c = await prisma.commission.findUnique({ where: { id: commissionId }, select: { id: true, sellerId: true, amountPaise: true, status: true } });
      if (!c || c.status !== 'PAID') return;
      await issueInvoice({ type: 'COMMISSION', refId: c.id, memberId: c.sellerId, totalPaise: toPaise(c.amountPaise) }, now);
    },
    { commissionId },
  );

export const issueFeatureInvoice = (purchaseId: string, now = new Date()) =>
  bestEffort(
    'invoice: feature',
    async () => {
      const p = await prisma.featurePurchase.findUnique({ where: { id: purchaseId }, select: { id: true, sellerId: true, auctionId: true, amountPaise: true, status: true } });
      if (!p || p.status !== 'PAID') return;
      const issued = await issueInvoice({ type: 'FEATURE', refId: p.id, memberId: p.sellerId, totalPaise: toPaise(p.amountPaise) }, now);
      await announce('FEATURE', issued, p.sellerId, toPaise(p.amountPaise), p.auctionId);
    },
    { purchaseId },
  );

export const issueDepositForfeitInvoice = (depositId: string, now = new Date()) =>
  bestEffort(
    'invoice: deposit forfeit',
    async () => {
      const d = await prisma.auctionDeposit.findUnique({ where: { id: depositId }, select: { id: true, memberId: true, auctionId: true, amountPaise: true, status: true } });
      if (!d || d.status !== 'FORFEITED') return;
      const issued = await issueInvoice({ type: 'DEPOSIT_FORFEIT', refId: d.id, memberId: d.memberId, totalPaise: toPaise(d.amountPaise) }, now);
      await announce('DEPOSIT_FORFEIT', issued, d.memberId, toPaise(d.amountPaise), d.auctionId);
    },
    { depositId },
  );

// ---------------------------------------------------------------- reads

export async function listMine(memberId: string, q: MineQuery) {
  const where = { memberId };
  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, type: true, totalPaise: true, isTaxInvoice: true, issuedAt: true },
      ...offsetArgs(q),
    }),
    prisma.invoice.count({ where }),
  ]);
  return { items: rows.map((r) => toInvoiceDTO(r as InvoiceRow)), meta: pageMeta(total, q) };
}

export async function listAll(q: AdminListQuery) {
  const term = q.q?.trim();
  const where: Prisma.InvoiceWhereInput = {
    ...(q.type ? { type: q.type } : {}),
    ...(term
      ? {
          OR: [
            { number: { contains: term, mode: 'insensitive' as const } },
            { buyerName: { contains: term, mode: 'insensitive' as const } },
            { buyerGstin: { contains: term, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, number: true, type: true, totalPaise: true, isTaxInvoice: true, issuedAt: true, memberId: true, buyerName: true, buyerGstin: true, taxablePaise: true },
      ...offsetArgs(q),
    }),
    prisma.invoice.count({ where }),
  ]);
  const items = rows.map((r) => ({
    ...toInvoiceDTO(r as InvoiceRow),
    memberId: r.memberId,
    buyerName: r.buyerName,
    buyerGstin: r.buyerGstin,
    taxablePaise: toPaise(r.taxablePaise),
  }));
  return { items, meta: pageMeta(total, q) };
}

// ---------------------------------------------------------------- PDF

async function describeInvoice(type: InvoiceTypeValue, refId: string): Promise<string> {
  const select = { auction: { select: { title: true } } } as const;
  const title =
    type === 'COMMISSION'
      ? (await prisma.commission.findUnique({ where: { id: refId }, select }))?.auction.title
      : type === 'FEATURE'
        ? (await prisma.featurePurchase.findUnique({ where: { id: refId }, select }))?.auction.title
        : (await prisma.auctionDeposit.findUnique({ where: { id: refId }, select }))?.auction.title;
  return invoiceDescription(type, title ?? 'auction');
}

/**
 * GET /invoices/:id/pdf: owner or SUPER_ADMIN (anyone else gets 404). The PDF is rendered on every request and the
 * bytes are streamed back; nothing is written to storage. `Invoice.pdfKey` is a legacy column (the PDF used to be
 * cached in S3) and is no longer read or written.
 */
export async function getInvoicePdf(viewer: { sub: string; role: string }, id: string): Promise<{ number: string; pdf: Buffer }> {
  const inv = await prisma.invoice.findUnique({ where: { id } });
  if (!inv || (inv.memberId !== viewer.sub && viewer.role !== 'SUPER_ADMIN')) throw invoiceNotFound();

  const [settings, description, { renderInvoicePdf }] = await Promise.all([getInvoiceSettings(), describeInvoice(inv.type, inv.refId), import('./invoice.pdf')]);
  const pdf = await renderInvoicePdf({
    number: inv.number,
    issuedAt: inv.issuedAt,
    isTaxInvoice: inv.isTaxInvoice,
    platform: { legalName: settings.legalName, gstin: settings.gstin, address: settings.address, stateCode: settings.stateCode },
    buyer: { name: inv.buyerName, gstin: inv.buyerGstin, state: inv.buyerState, placeOfSupply: inv.placeOfSupply },
    description,
    sacCode: settings.sacCode,
    gstRateBps: settings.gstRateBps,
    taxablePaise: toPaise(inv.taxablePaise),
    cgstPaise: toPaise(inv.cgstPaise),
    sgstPaise: toPaise(inv.sgstPaise),
    igstPaise: toPaise(inv.igstPaise),
    totalPaise: toPaise(inv.totalPaise),
  });
  return { number: inv.number, pdf };
}
