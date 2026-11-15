import { amountInWords } from './invoice.rules';

export type InvoicePdfData = {
  number: string;
  issuedAt: Date;
  isTaxInvoice: boolean;
  platform: { legalName: string; gstin: string | null; address: string; stateCode: string };
  buyer: { name: string; gstin: string | null; state: string | null; placeOfSupply: string | null };
  description: string;
  sacCode: string;
  gstRateBps: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
};

const rs = (paise: number) => `Rs. ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateIst = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** A4 invoice / receipt as a PDF buffer (pdfkit is loaded on first use to keep Lambda cold start small). */
export async function renderInvoicePdf(d: InvoicePdfData): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `${d.isTaxInvoice ? 'Tax invoice' : 'Receipt'} ${d.number}` } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 50;
  const right = 545;
  doc.font('Helvetica-Bold').fontSize(20).text(d.isTaxInvoice ? 'Tax invoice' : 'Receipt', left, 50);
  doc.font('Helvetica').fontSize(10).fillColor('#444');
  doc.text(`Invoice no: ${d.number}`, left, 54, { width: right - left, align: 'right' });
  doc.text(`Date: ${dateIst(d.issuedAt)}`, left, 68, { width: right - left, align: 'right' });

  doc.fillColor('#000').font('Helvetica-Bold').fontSize(12).text(d.platform.legalName, left, 100);
  doc.font('Helvetica').fontSize(10);
  if (d.platform.address) doc.text(d.platform.address, { width: 260 });
  if (d.platform.gstin) doc.text(`GSTIN: ${d.platform.gstin}`);
  doc.text(`State code: ${d.platform.stateCode}`);

  doc.font('Helvetica-Bold').fontSize(11).text('Billed to', 340, 100);
  doc.font('Helvetica').fontSize(10).text(d.buyer.name, 340, 116, { width: right - 340 });
  if (d.buyer.gstin) doc.text(`GSTIN: ${d.buyer.gstin}`, 340);
  if (d.buyer.state) doc.text(`State code: ${d.buyer.state}`, 340);
  if (d.buyer.placeOfSupply) doc.text(`Place of supply: ${d.buyer.placeOfSupply}`, 340);

  const tableTop = 225;
  doc.moveTo(left, tableTop).lineTo(right, tableTop).strokeColor('#999').stroke();
  doc.font('Helvetica-Bold').fontSize(10);
  doc.text('Description', left, tableTop + 8, { width: 300 });
  doc.text('SAC', 360, tableTop + 8, { width: 60 });
  doc.text('Taxable value', 430, tableTop + 8, { width: right - 430, align: 'right' });
  doc.moveTo(left, tableTop + 24).lineTo(right, tableTop + 24).stroke();
  doc.font('Helvetica');
  const rowY = tableTop + 32;
  doc.text(d.description, left, rowY, { width: 300 });
  doc.text(d.sacCode, 360, rowY, { width: 60 });
  doc.text(rs(d.taxablePaise), 430, rowY, { width: right - 430, align: 'right' });

  let y = rowY + 60;
  const line = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 300, y, { width: 130 });
    doc.text(value, 430, y, { width: right - 430, align: 'right' });
    y += 18;
  };
  line('Taxable value', rs(d.taxablePaise));
  if (d.isTaxInvoice) {
    if (d.igstPaise > 0) line(`IGST (${pct(d.gstRateBps)})`, rs(d.igstPaise));
    else {
      line(`CGST (${pct(d.gstRateBps / 2)})`, rs(d.cgstPaise));
      line(`SGST (${pct(d.gstRateBps / 2)})`, rs(d.sgstPaise));
    }
  }
  doc.moveTo(300, y).lineTo(right, y).stroke();
  y += 6;
  line('Total', rs(d.totalPaise), true);

  doc.font('Helvetica').fontSize(10).text(`Amount in words: ${amountInWords(d.totalPaise)}`, left, y + 20, { width: right - left });
  doc.fontSize(9).fillColor('#666');
  if (!d.isTaxInvoice) doc.text('This is a receipt, not a tax invoice. No GST has been charged separately.', left, y + 50, { width: right - left });
  doc.text('This is a computer generated document and needs no signature.', left, 780, { width: right - left, align: 'center' });
  doc.end();
  return done;
}
