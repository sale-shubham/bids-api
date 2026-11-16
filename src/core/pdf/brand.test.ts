import { describe, expect, it, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { BRAND_LOGO_PNG, BRAND_LOGO_RATIO } from './brand-logo';
import { drawHeaderLogo, drawWatermark, WATERMARK_OPACITY, WATERMARK_WIDTH_RATIO } from './brand';

const finish = (doc: PDFKit.PDFDocument) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });

describe('brand logo', () => {
  it('is a 256x256 PNG', () => {
    expect(BRAND_LOGO_PNG.subarray(1, 4).toString()).toBe('PNG');
    expect(BRAND_LOGO_PNG.readUInt32BE(16)).toBe(256);
    expect(BRAND_LOGO_PNG.readUInt32BE(20)).toBe(256);
    expect(BRAND_LOGO_RATIO).toBe(1);
  });
});

describe('drawWatermark', () => {
  it('draws a centred, faint, large logo on every page, including automatic overflow pages', async () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const image = vi.spyOn(doc, 'image');
    const opacity = vi.spyOn(doc, 'opacity');
    drawWatermark(doc);
    doc.text('page one', 50, 50);
    doc.addPage();
    doc.text('page two');
    // Enough lines to overflow onto further, automatically added pages.
    for (let i = 0; i < 120; i++) doc.text(`line ${i}`);
    const range = doc.bufferedPageRange();
    const pages = range.start + range.count;
    expect(pages).toBeGreaterThanOrEqual(3);
    const buf = await finish(doc);

    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(image).toHaveBeenCalledTimes(pages);
    const w = 595.28 * WATERMARK_WIDTH_RATIO;
    for (const call of image.mock.calls) {
      const [, x, y, opts] = call as unknown as [Buffer, number, number, { width: number }];
      expect(opts.width).toBeCloseTo(w, 1);
      expect(x).toBeCloseTo((595.28 - w) / 2, 1);
      expect(y).toBeCloseTo((841.89 - w) / 2, 1);
    }
    expect(opacity).toHaveBeenCalledWith(WATERMARK_OPACITY);
    expect(WATERMARK_WIDTH_RATIO).toBeGreaterThanOrEqual(0.55);
    expect(WATERMARK_WIDTH_RATIO).toBeLessThanOrEqual(0.65);
    expect(WATERMARK_OPACITY).toBeGreaterThanOrEqual(0.06);
    expect(WATERMARK_OPACITY).toBeLessThanOrEqual(0.08);
  });

  it('draws before any content on a new page and leaves the cursor at the margins', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    vi.spyOn(doc, 'image').mockImplementation(function (this: PDFKit.PDFDocument) {
      // Simulate an image call that disturbs the cursor, as a naive implementation would.
      doc.x = 5;
      doc.y = 5;
      return this;
    });
    drawWatermark(doc);
    doc.x = 77;
    doc.y = 123;
    doc.addPage();
    expect([doc.x, doc.y]).toEqual([50, 50]);
    doc.end();
  });
});

describe('drawHeaderLogo', () => {
  it('draws at the given spot and leaves the cursor alone', () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const image = vi.spyOn(doc, 'image');
    doc.x = 60;
    doc.y = 90;
    drawHeaderLogo(doc, 50, 94, 40);
    expect(image).toHaveBeenCalledWith(expect.anything(), 50, 94, { width: 40, height: 40 });
    expect([doc.x, doc.y]).toEqual([60, 90]);
    doc.end();
  });

  it('embeds the logo once per document when the watermark and header logo both draw', async () => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const openImage = vi.spyOn(doc as unknown as { openImage: (src: Buffer) => unknown }, 'openImage');
    const image = vi.spyOn(doc, 'image');
    drawWatermark(doc);
    drawHeaderLogo(doc, 50, 94, 40);
    doc.addPage();
    drawHeaderLogo(doc, 50, 94, 40);
    doc.text('body');
    const buf = await finish(doc);

    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    expect(openImage).toHaveBeenCalledTimes(1);
    expect(openImage).toHaveBeenCalledWith(BRAND_LOGO_PNG);
    // Watermark and header logo on each of the two pages: four draws, all using the same opened image.
    expect(image).toHaveBeenCalledTimes(4);
    const sources = new Set(image.mock.calls.map((c) => c[0]));
    expect(sources.size).toBe(1);
    expect(sources.has(openImage.mock.results[0]?.value)).toBe(true);
  });
});
