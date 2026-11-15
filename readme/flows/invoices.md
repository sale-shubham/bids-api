# GST invoices

Code: `src/modules/invoices/` (`invoice.rules` pure helpers, `invoice.settings`, `invoices.service`, `invoice.pdf`, `invoices.routes`).

## Settings (admin only, never public)

`GET/PUT /admin/settings/invoice` (separate from platform settings, like `/legal`): `legalName`, `gstin` (optional, 15-char GSTIN regex; its first two digits must equal `stateCode`, else 400 `INVALID_GSTIN`), `address`, `stateCode` (2-digit GST code, default `27`), `gstRateBps` (1800), `commissionInclusive` (true), `sacCode` (`998599`). Stored as `invoice.*` AppSettings (seeded).

Members set `gstin` and `billingState` through `PATCH /members/me` (format checked; when both are given the GSTIN prefix must equal `billingState`, else 400 `INVALID_GSTIN`).

## Numbering and tax

- Financial year = April to March in Asia/Kolkata (`2026-27`). Number `NB/<FY>/<seq padded to 6>`. One transaction: upsert `InvoiceCounter`, `UPDATE ... SET seq = seq + 1 RETURNING seq`, insert the `Invoice`. `@@unique([type, refId])` makes issuing idempotent; a duplicate rolls the counter back.
- `computeInvoiceTax`: platform GSTIN set -> tax invoice; inclusive: taxable = round(total x 10000 / (10000 + rate)), tax = total - taxable. Buyer state equals the platform state (or is unknown) -> CGST = floor(tax / 2), SGST = tax - CGST (odd paisa in SGST); otherwise IGST. No platform GSTIN -> `isTaxInvoice: false`, taxable = total, taxes 0 (a "Receipt").
- Amounts already charged are ALWAYS treated as GST-inclusive. `invoice.commissionInclusive = false` (tax on top) is display-only for future prices and never changes what was charged (D15; CA review pending).

## Issuing (best-effort after the payment effect; failures are logged, never thrown)

| Trigger | Type | Billed member |
|---|---|---|
| Commission becomes PAID (Razorpay, credits, and the PAID row written by `markSalePaid`) | `COMMISSION` | seller |
| Feature purchase PAID (Razorpay or credits) | `FEATURE` | seller |
| Deposit FORFEITED (deposit release job) | `DEPOSIT_FORFEIT` | bidder |

`commission-paid` carries a "Download your invoice" link to `/profile?tab=invoices`; FEATURE and DEPOSIT_FORFEIT send the new `invoice-issued` notification (mandatory email).

## Endpoints

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/invoices/mine?page&pageSize` | member | paginated `{ id, number, type, totalPaise, isTaxInvoice, issuedAt }` |
| GET | `/invoices/:id/pdf` | owner or SUPER_ADMIN (else 404 `INVOICE_NOT_FOUND`) | `{ url }` presigned for 5 minutes |
| GET | `/admin/invoices?type=&q=&page&pageSize` | SUPER_ADMIN | paginated list plus `memberId, buyerName, buyerGstin, taxablePaise`; `q` matches number, buyer name, GSTIN |

## PDF and storage

`invoice.pdf.ts` (pdfkit, loaded on first use): A4, platform details, number and date (IST), buyer, line item with SAC, taxable / CGST / SGST / IGST / total, title "Tax invoice" or "Receipt", amount in words (Indian numbering). Rendered on the first request and stored privately at `invoices/<financialYear>/<id>.pdf` (`storage.putObject`, never public: the bucket policy only exposes `auctions/` and `avatars/`); every request mints a fresh `storage.presignGet(key, 300)`. The Lambda bundle copies `node_modules/pdfkit/js/data` to `dist/data` and defines `__dirname` (`scripts/build-lambda.mjs`) because pdfkit reads its font metrics from disk. There is no stub storage driver; tests mock `@/providers/storage`.

## Tests

`src/modules/invoices/invoices.test.ts` (FY boundary, numbering, tax splits, idempotency, PDF, owner check, GSTIN validation).
