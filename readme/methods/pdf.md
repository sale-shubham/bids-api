# PDF branding

Every PDF the API renders is branded through `src/core/pdf/brand.ts`. Today the only PDF is the invoice / receipt (`src/modules/invoices/invoice.pdf.ts`); any new one should use the same helpers.

## Helpers

- `drawWatermark(doc)`: a large NobleBid logo (60% of the page width, opacity 0.07) centred on the page. Call it once, right after `new PDFDocument(...)` and before any content. It draws on the current page and hooks `pageAdded`, so every later page (explicit `addPage` or automatic overflow) gets it before its content, which keeps it behind the text. It runs inside `doc.save()` / `doc.restore()` and restores `doc.x` / `doc.y`, so the text cursor never moves.
- `drawHeaderLogo(doc, x, y, size = 40)`: a small logo for the header (the invoice puts it left of the platform legal name and indents the name and address block to clear it). Also leaves the cursor alone.
- Tunables: `WATERMARK_WIDTH_RATIO`, `WATERMARK_OPACITY`, `HEADER_LOGO_SIZE`.

## The logo file

`src/core/pdf/brand-logo.ts` holds the logo as base64 (`BRAND_LOGO_PNG`, `BRAND_LOGO_RATIO`), so the Lambda bundle needs no file on disk. Source: `bids-app/public/logo.png`, resized to 256x256 RGBA and palette-quantised with sharp (about 28 KB base64 instead of about 315 KB at 512 px). To regenerate, from `bids-app` (where sharp is installed):

```
node -e "require('sharp')('public/logo.png').resize(256,256,{fit:'fill'}).png({compressionLevel:9,palette:true,quality:100,effort:10}).toBuffer().then(b=>console.log(b.toString('base64')))"
```

Paste the output as the string in `brand-logo.ts` and update `BRAND_LOGO_RATIO` (width / height) if the new file is not square.

pdfkit caches images only when they are opened from a string path, so passing the Buffer to `doc.image()` embeds the PNG and its alpha SMask again on every call. `brand.ts` opens the logo once per document (`doc.openImage`, cached in a `WeakMap`) and passes that to both the watermark and the header logo. A one-page invoice carries exactly two image objects (image and SMask).

## Serving a PDF

Stream the bytes with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="..."`, `Content-Length` and `Cache-Control: private, no-store`. On Lambda this needs the `binarySettings` in `index.js` (`flows/deployment.md`). Fonts: pdfkit's AFM data is copied to `dist/data` by `scripts/build-lambda.mjs`.

## Tests

`src/core/pdf/brand.test.ts` spies on `doc.image` to prove the watermark is drawn on every page of a multi-page document, and that the watermark and header logo together call `openImage` once per document.
