import { BRAND_LOGO_PNG, BRAND_LOGO_RATIO } from './brand-logo';

/** Minimal slice of a pdfkit document these helpers use (keeps pdfkit out of this module's imports: it is loaded lazily). */
type Doc = PDFKit.PDFDocument;

/**
 * pdfkit's opened image: the PNG decoded and ready to embed. @types/pdfkit does not declare `openImage`, so it is typed here.
 * `doc.image()` takes it in place of the PNG buffer and skips decoding.
 */
type OpenedImage = { width: number; height: number };

/**
 * pdfkit only caches images opened from string paths, so a Buffer passed to `doc.image()` is embedded again on every call.
 * Open the logo once per document and reuse it for the watermark on every page and the header logo.
 */
const openedLogos = new WeakMap<Doc, OpenedImage>();

const logoSource = (doc: Doc): Buffer => {
  let img = openedLogos.get(doc);
  if (!img) {
    img = (doc as Doc & { openImage(src: Buffer): OpenedImage }).openImage(BRAND_LOGO_PNG);
    openedLogos.set(doc, img);
  }
  return img as unknown as Buffer; // typed as Buffer only to satisfy @types/pdfkit's ImageSrc; pdfkit accepts the opened image here.
};

/** Watermark width as a share of the page width, and its opacity (low enough that text on top stays readable). */
export const WATERMARK_WIDTH_RATIO = 0.6;
export const WATERMARK_OPACITY = 0.07;
export const HEADER_LOGO_SIZE = 40;

const stamp = (doc: Doc) => {
  const w = doc.page.width * WATERMARK_WIDTH_RATIO;
  const h = w / BRAND_LOGO_RATIO;
  // Keep the text cursor where the content left it: drawing an image must never move it.
  const { x, y } = doc;
  doc.save();
  doc.opacity(WATERMARK_OPACITY);
  doc.image(logoSource(doc), (doc.page.width - w) / 2, (doc.page.height - h) / 2, { width: w });
  doc.restore();
  doc.x = x;
  doc.y = y;
};

/**
 * Large faint logo centred on every page. Call it once, right after creating the document and before any content:
 * it draws on the current (first) page now and on every page pdfkit adds later (explicit addPage or automatic
 * overflow) through the `pageAdded` hook, which fires before the new page's content, so the logo sits behind it.
 */
export function drawWatermark(doc: Doc): void {
  stamp(doc);
  doc.on('pageAdded', () => stamp(doc));
}

/** Small logo for a document header; `size` is the side length in points. Leaves the text cursor untouched. */
export function drawHeaderLogo(doc: Doc, x: number, y: number, size = HEADER_LOGO_SIZE): void {
  const { x: cx, y: cy } = doc;
  doc.image(logoSource(doc), x, y, { width: size, height: size / BRAND_LOGO_RATIO });
  doc.x = cx;
  doc.y = cy;
}
