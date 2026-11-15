# Legal pages, public settings, contact

Code: `src/modules/settings/{settings.routes,settings.service,settings.validation,legal-pages.service,legal-pages.sanitize,legal-pages.constants}.ts`, `src/modules/contact/*`, `prisma/legal-seed-content.ts`.

## Legal pages

Fixed slugs: `terms-conditions`, `privacy-policy`, `refund-policy`. Stored in AppSetting: `page:<slug>` (HTML) and `page-title:<slug>`. No migration.

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/settings/legal` | public | `{ pages: [{ slug, title, content, updatedAt }] }` |
| GET | `/settings/legal/:slug` | public | `{ slug, title, content (HTML), updatedAt }`; an unedited page has empty content, default title, `updatedAt: null`; unknown slug 400 |
| GET | `/admin/settings/legal` | SUPER_ADMIN | same list |
| PUT | `/admin/settings/legal/:slug` | SUPER_ADMIN | `{ title 2-120, content }` -> page object. Content is sanitised server-side (`sanitize-html`): allowed `p br strong em u s ul ol li h2 h3 blockquote a` (links get `rel="noopener noreferrer nofollow" target="_blank"`, schemes http/https/mailto); scripts, handlers, images and other tags are stripped. |

Replaced paths: the older `GET /settings/pages[/:slug]` and `GET|PUT /admin/settings/pages` (bulk, unsanitised) are removed in favour of the above.

Seed (`npm run prisma:seed`, never run automatically): `prisma/seed.ts` inserts NobleBid draft text for the three pages with `update: {}`, so existing (admin-edited) rows are never overwritten. Every draft starts with "Draft — have this reviewed by a lawyer before launch" and covers online auctions, the 5% seller commission via Razorpay, bidder obligations, Indian law, and (privacy) the DPDP Act 2023. They are not legal advice.

## Public settings

`GET /settings/public` -> `{ commissionRateBps, minIncrementPaise, antiSnipingMinutes, maxPricePaise, categories, checkoutMode, depositThresholdPaise, depositRateBps }` (AppSetting keys `commission.rateBps`, `auction.minIncrementPaise`, `auction.antiSnipingMinutes`, `auction.maxPricePaise`; `categories` is derived from the active root `Category` names, sorted, see `categories.md`; defaults 500 / 10000 / 2 / 10000000000; `maxPricePaise` is a JSON number, the highest price a listing or bid may have; `depositThresholdPaise` (default 10000000, 0 = off) and `depositRateBps` (default 1000) drive bid deposits, `deposits.md`). Admin edit: see `admin.md`.

## Contact

`POST /contact` `{ name 2-80, email, subject 3-120, message 10-4000 }` -> `{ received: true }`. Public; `contactLimiter` (5 per hour per IP, Pg-backed store) runs before validation. Sends the `contact-message` email to `ADMIN_EMAIL` with `Reply-To` = the sender (`SendEmailInput.replyTo`, SES `ReplyToAddresses`). 503 `SERVICE_UNAVAILABLE` if `ADMIN_EMAIL` is unset. The message is not stored.

Page slugs (`src/modules/settings/legal-pages.constants.ts`): `privacy-policy`, `terms-conditions`, `refund-policy`, `prohibited-items`. `prohibited-items` ("Prohibited items") lists the banned categories: weapons, drugs, counterfeit goods, stolen property, live animals, hazardous materials, adult content, government IDs, items infringing IP. Its default draft body is in `prisma/legal-seed-content.ts` and is created by `npm run prisma:seed` only when missing (admin edits are never overwritten); until seeded it returns empty content like any unedited page. It backs the report flow (`reports.md`).
