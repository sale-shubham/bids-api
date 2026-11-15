import { prisma } from '@/core/prisma/client';
import { AppError } from '@/core/errors/AppError';
import { gstinMatchesState } from './invoice.rules';

// Platform billing identity. AppSetting rows (admin-only, never in /settings/public).
const K = {
  legalName: 'invoice.legalName',
  gstin: 'invoice.gstin',
  address: 'invoice.address',
  stateCode: 'invoice.stateCode',
  gstRateBps: 'invoice.gstRateBps',
  commissionInclusive: 'invoice.commissionInclusive',
  sacCode: 'invoice.sacCode',
} as const;

export interface InvoiceSettings {
  legalName: string;
  gstin: string | null;
  address: string;
  stateCode: string;
  gstRateBps: number;
  /** Display-only: amounts already charged are always treated as GST-inclusive (decision D15). */
  commissionInclusive: boolean;
  sacCode: string;
}

export const INVOICE_DEFAULTS: InvoiceSettings = {
  legalName: 'NobleBid',
  gstin: null,
  address: '',
  stateCode: '27',
  gstRateBps: 1800,
  commissionInclusive: true,
  sacCode: '998599',
};

export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(K) } } });
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const rate = Number.parseInt(m.get(K.gstRateBps) ?? '', 10);
  return {
    legalName: m.get(K.legalName) || INVOICE_DEFAULTS.legalName,
    gstin: m.get(K.gstin) || null,
    address: m.get(K.address) ?? INVOICE_DEFAULTS.address,
    stateCode: m.get(K.stateCode) || INVOICE_DEFAULTS.stateCode,
    gstRateBps: Number.isFinite(rate) && rate >= 0 && rate <= 5000 ? rate : INVOICE_DEFAULTS.gstRateBps,
    commissionInclusive: m.get(K.commissionInclusive) !== 'false',
    sacCode: m.get(K.sacCode) || INVOICE_DEFAULTS.sacCode,
  };
}

export async function setInvoiceSettings(input: InvoiceSettings): Promise<InvoiceSettings> {
  const gstin = input.gstin ? input.gstin.toUpperCase() : null;
  if (!gstinMatchesState(gstin, input.stateCode)) {
    throw new AppError(400, 'INVALID_GSTIN', 'GSTIN does not match the state code');
  }
  const entries: [string, string][] = [
    [K.legalName, input.legalName],
    [K.gstin, gstin ?? ''],
    [K.address, input.address],
    [K.stateCode, input.stateCode],
    [K.gstRateBps, String(input.gstRateBps)],
    [K.commissionInclusive, String(input.commissionInclusive)],
    [K.sacCode, input.sacCode],
  ];
  await prisma.$transaction(entries.map(([key, value]) => prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })));
  return getInvoiceSettings();
}
