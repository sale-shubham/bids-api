# Notifications flow

Code: pipeline in `src/modules/notify/` (`notify.queue.ts`, `notify.service.ts`, `notify.worker.ts`, `notify.content.ts`, `notify.types.ts`); in-app inbox API in `src/modules/notifications/`; email templates in `src/templates/` (`outbid`, `auction-won`, `auction-sold`, `auction-unsold`, `reserve-not-met`, `commission-due`, `commission-paid`, `review-received`, `question-asked`, `question-answered`, `saved-search-match`, `sale-receipt`, `sale-paid`, `sale-shipped`, `sale-released`, `sale-disputed`, `sale-refunded`, `sale-cancelled`, `report-filed`, `deposit-held`, `deposit-refunded`, `deposit-forfeited`, `strike-issued`, `account-suspended`, `second-chance-offer`, `second-chance-accepted`, `second-chance-declined`, `shill-flag`, `followed-seller-listed`, each `.ejs` + `.txt.ejs`, sharing `_head` / `_foot` / `_contact` partials; auction/commission links use `env.app.url`; support `/contact` links use `env.app.websiteUrl` = `WEBSITE_URL`, passed to templates as `websiteUrl` by `renderEmail`).

## In-app endpoints (auth required)

| Method | Path | Response |
|---|---|---|
| GET | `/notifications` | `paginated({ id, type, title, body, url, readAt, createdAt }[])`, newest first (`page`, `pageSize`) |
| GET | `/notifications/unread-count` | `{ count }` |
| POST | `/notifications/:id/read` | `{ id }`; 404 if it is not the caller's; idempotent |
| POST | `/notifications/read-all` | `{ count }` marked |

Model `Notification { id, memberId, type, title, body, url, data Json?, dedupeKey @unique, readAt?, createdAt }`, index `(memberId, readAt, createdAt)`, cascade on member delete.

## Engagement 2 types

`feature-activated` (seller, featured listing paid, `featured.md`), `referral-rewarded` (referrer, credits added, `referrals.md`) and `invoice-issued` (FEATURE and DEPOSIT_FORFEIT invoices; email cannot be turned off, `invoices.md`). All three are in `notify.catalogue.ts`; `commission-paid` now also links to `/profile?tab=invoices`.

## Pipeline

`enqueueNotification({ type, memberId, auctionId?, data?, dedupeKey })`:
- `NOTIFY_QUEUE_URL` set (Lambda) -> SQS `SendMessage`; the `notifyWorker` Lambda (batch 10, `ReportBatchItemFailures`, SQS `maximumConcurrency: 5` instead of reserved concurrency, because new AWS accounts have only 10 concurrency slots) runs `processSqsBatch`, which returns `{ batchItemFailures: [{ itemIdentifier: messageId }] }` for failed records (after 3 receives SQS moves them to NotifyDLQ).
- Unset (local dev) -> `processNotification` inline; errors are logged, never thrown. Enqueue itself never throws (a notification must not fail a bid or the close job).

Dedupe keys: `outbid:<bidId>:<memberId>`, `auction-won:<auctionId>`, `auction-sold:<auctionId>`, `commission-due:<auctionId>`, `commission-paid:<commissionId>`, `commission-reminder:<commissionId>:<YYYY-MM-DD>` (daily reminder, type `commission-due`), `auction-unsold:<auctionId>:<endedAtMs>` (the timestamp lets a republished auction notify again), `reserve-not-met:<auctionId>:<endedAtMs>`, `review-received:<reviewId>`, `question-asked:<questionId>`, `question-answered:<questionId>`, `ssm:<auctionId>:<memberId>`, `sale-paid|sale-receipt|sale-shipped|sale-released:<saleId>`, `sale-disputed:<saleId>` (seller) and `sale-disputed:<saleId>:<adminId>`, `sale-refunded:<saleId>:<memberId>`, `sale-cancelled:<saleId>:<memberId>`, `report-filed:<reportId>:<adminId>`, `deposit-held|deposit-refunded|deposit-forfeited:<depositId>`, `strike-issued:<strikeId>`, `account-suspended:<strikeId>`, `second-chance-offer|second-chance-accepted|second-chance-declined:<offerId>`, `shill-flag:<auctionId>:<bidderId>:<adminId>`.

`report-filed` (to every active SUPER_ADMIN when a member files a report; no auction, `data { reportId, targetType, reason, targetLabel }`, url `/admin/reports`; `reports.md`). Template variables `targetType`, `reason`, `targetLabel`, `reportsUrl`, escaped.

Checkout types (`checkout.md`): `sale-receipt` (buyer, payment received), `sale-paid` (seller, ship the item), `sale-shipped` (buyer, `data { courier, trackingNo }`), `sale-released` (seller, `data.payoutPaise`), `sale-disputed` (seller and each SUPER_ADMIN, `data.reason`), `sale-refunded` and `sale-cancelled` (both). `data` always has `saleId`, `role` (`BUYER` / `SELLER` / `ADMIN`, picks the link: `/purchases/<id>`, `/sell/sales/<id>`, `/admin/sales`) and `amountPaise`. In checkout mode `auction-won` carries `data { saleId, payBy }` ("Pay within 3 days", url `/purchases/<saleId>`) and `auction-sold` carries `data { checkout: true, saleId, payBy }`; both skip the counterparty contact card (contact details are shared only once the sale is paid, via `SaleDTO`) and no `commission-due` is sent. Template variables for these are always passed (`checkout`, `payBy`, `saleUrl`, `amount`, `payout`, `shipping`, `reason`); all output is escaped (`<%= %>`).

New types: `review-received` (to the seller, url `/sellers/<sellerId>`, `data { rating, sellerId }`; see `reviews.md`), `question-asked` (to the seller, `data { question }`) and `question-answered` (to the asker, `data { answer }`; see `questions.md`), `saved-search-match` (to a member whose saved search matches a new listing, `data { searchName }`; see `saved-searches.md`). The question / answer text is clipped to 200 chars in the in-app body and email; templates use escaped `<%= %>` only.

`reserve-not-met` (type added to `NOTIFY_TYPES`) goes to the highest bidder when an auction with bids ends below its hidden reserve (they did not win and are not charged). In the same case the seller's `auction-unsold` carries `data.reserveNotMet: true`, which switches its in-app copy, email subject and both templates to "ended below your reserve". `outbid` now goes only to the member who lost the lead in the request, and its `yourBidPaise` is that member's max bid.

`followed-seller-listed` (to a follower of the seller when they publish; `data { sellerName }`, url `/auctions/<id>`; "<seller> listed <title>"; template `followed-seller-listed`, dedupe `fsl:<auctionId>:<memberId>`; see `follows.md`).

Channels and preferences (`notification-preferences.md`): `processNotification` loads the member's `NotificationPreference` for the type (one query; a missing row = email + push on, WhatsApp off) and `resolveChannels` (`notify.catalogue.ts`) decides email / push / WhatsApp. Email is always sent for the mandatory types (`sale-*`, `deposit-*`, `commission-due`, `commission-paid`, `strike-issued`, `account-suspended`, `auction-won`, `second-chance-offer`). The in-app inbox row and the live WebSocket event are always created. WhatsApp goes out only when the preference is on, the member opted in (`whatsappOptInAt`), the phone is verified and the type is capable (`outbid`, `ending-soon`, `auction-won`); it is sent after the row insert, a failure is only logged and never rethrown (not even with `rethrowEmailErrors`). Dedupe semantics are unchanged.

`processNotification` order (idempotent, retry-safe):
1. dedupeKey already has a row -> `duplicate`, stop.
2. Member missing or `isActive = false` -> `skipped` (nothing is sent or stored).
3. Send the email (skipped when the channel is off). In the worker an email failure is rethrown here, before any row exists, so SQS retries the whole message. Inline it is logged and delivery continues.
4. Insert the `Notification` row. A unique violation (concurrent duplicate) = `duplicate`.
5. `sendPushToMember(memberId, { type, title, body, url })` only if this call inserted the row and the push channel is on.
6. WhatsApp template message (same conditions as push plus the WhatsApp gates above); errors are logged.

Accepted trade-offs: if the email send succeeded but the insert fails, the retry sends the email a second time (a rare duplicate email is preferred over a lost one); if the email fails permanently the in-app row is not created and the message ends in the DLQ.

Contact details for `auction-won` (seller) and `auction-sold` (winner) are loaded at processing time, never put on the queue. Amounts are formatted as INR (`en-IN`) by `formatInr`.

Trust-2 types (`buildContent` passes the auction title when `auctionId` is set):

| Type | To | Data | Url |
|---|---|---|---|
| `deposit-held` / `deposit-refunded` / `deposit-forfeited` | the depositor (`deposits.md`) | `amountPaise` | `/auctions/<id>` |
| `strike-issued` | the unpaid winner (`strikes.md`) | `strikeCount`, `depositsRequired` (true at the 2nd strike: "a deposit is now required on every bid"), `expiresAt` | `/purchases` |
| `account-suspended` | the member at the 3rd active strike | `strikeCount` | `/contact` |
| `second-chance-offer` | the runner-up | `offerId`, `amountPaise`, `expiresAt` | `/purchases/offers/<offerId>` |
| `second-chance-accepted` / `second-chance-declined` | the seller | `offerId`, `saleId` (accepted: the new sale, plus `amountPaise`) | `/sell/sales/<saleId>` |
| `shill-flag` | every active SUPER_ADMIN (`risk.md`) | `bidderId`, `sellerId`, `score`, `reasons[]` | `/admin/risk` |

`processNotification` skips inactive members **except** `account-suspended` (it is queued while the account is being deactivated).
