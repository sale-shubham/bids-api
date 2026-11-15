export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const STATE_CODE_RE = /^(0[1-9]|[1-2][0-9]|3[0-9])$/;

export const INVOICE_TYPES = ['COMMISSION', 'FEATURE', 'DEPOSIT_FORFEIT'] as const;
export type InvoiceTypeValue = (typeof INVOICE_TYPES)[number];

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Indian financial year (April to March) of an instant, read in Asia/Kolkata: `2026-27`. */
export function financialYearOf(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const invoiceNumber = (financialYear: string, seq: number): string => `NB/${financialYear}/${String(seq).padStart(6, '0')}`;

/** Both given: the GSTIN's first two digits are the state code and must match the billing state. */
export function gstinMatchesState(gstin: string | null | undefined, state: string | null | undefined): boolean {
  if (!gstin || !state) return true;
  return gstin.slice(0, 2) === state;
}

export type InvoiceTaxInput = {
  totalPaise: number;
  /** Platform GSTIN; empty = not registered, so the document is a receipt with no tax. */
  platformGstin: string | null;
  platformStateCode: string;
  /** Buyer's billing state; unknown is treated as the platform's state (intra-state). */
  buyerState: string | null;
  gstRateBps: number;
  /** true = `totalPaise` already contains the tax (always the case for amounts already charged). */
  inclusive: boolean;
};

export type InvoiceTax = {
  isTaxInvoice: boolean;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
};

/**
 * GST split of one amount. Inclusive: taxable = round(total x 10000 / (10000 + rate)), tax = total - taxable.
 * Exclusive: taxable = total, tax = round(total x rate / 10000), total = taxable + tax (display of new prices only;
 * amounts already charged are always passed as inclusive). Intra-state: CGST = floor(tax / 2), SGST gets the odd paisa.
 */
export function computeInvoiceTax(i: InvoiceTaxInput): InvoiceTax {
  if (!i.platformGstin) {
    return { isTaxInvoice: false, taxablePaise: i.totalPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: i.totalPaise };
  }
  let taxable: number;
  let tax: number;
  let total: number;
  if (i.inclusive) {
    total = i.totalPaise;
    taxable = Math.round((total * 10_000) / (10_000 + i.gstRateBps));
    tax = total - taxable;
  } else {
    taxable = i.totalPaise;
    tax = Math.round((taxable * i.gstRateBps) / 10_000);
    total = taxable + tax;
  }
  const intra = !i.buyerState || i.buyerState === i.platformStateCode;
  const cgst = intra ? Math.floor(tax / 2) : 0;
  const sgst = intra ? tax - cgst : 0;
  return { isTaxInvoice: true, taxablePaise: taxable, cgstPaise: cgst, sgstPaise: sgst, igstPaise: intra ? 0 : tax, totalPaise: total };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
  const r = n % 100;
  if (r > 0) parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`);
  return parts.join(' ');
}

function wholeInWords(n: number): string {
  if (n === 0) return 'Zero';
  const units: [number, string][] = [[10_000_000, 'Crore'], [100_000, 'Lakh'], [1000, 'Thousand']];
  const parts: string[] = [];
  let rest = n;
  for (const [size, name] of units) {
    const q = Math.floor(rest / size);
    if (q > 0) parts.push(`${wholeInWords(q)} ${name}`);
    rest %= size;
  }
  if (rest > 0) parts.push(below1000(rest));
  return parts.join(' ');
}

/** `Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only` (Indian numbering). */
export function amountInWords(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const base = `Rupees ${wholeInWords(rupees)}`;
  return p > 0 ? `${base} and ${wholeInWords(p)} Paise Only` : `${base} Only`;
}

export const invoiceDescription = (type: InvoiceTypeValue, title: string): string =>
  type === 'COMMISSION'
    ? `Platform commission for auction "${title}"`
    : type === 'FEATURE'
      ? `Featured listing placement for auction "${title}"`
      : `Bid deposit forfeited (cancellation charge) for auction "${title}"`;
