# Shill-bid detection flow

Code: `src/modules/risk/` (`risk.{rules,service,jobs}.ts`), admin review in `src/modules/admin/risk/`, daily Lambda `riskScan` (`index.riskScanHandler`), manual run `npm run job:risk` (`scripts/run-risk.ts`). Decision: D12 in `docs/DECISIONS.md`.

**Signals are flags for review only. Nothing is ever blocked automatically.** An admin decides, and acts through the existing endpoints (cancel auction, suspend member, ...).

## Model

`ShillSignal { id, auctionId, bidderId, sellerId, score Int, reasons Json (string[]), createdAt, updatedAt, reviewedAt?, reviewedById?, outcome RiskOutcome? (DISMISSED | ACTION_TAKEN), note? }`, `@@unique([auctionId, bidderId])`, `@@index([reviewedAt, score])`. Cascade on auction / member delete.

## Live check (after every committed bid)

`checkBidRisk({ auctionId, bidderId, sellerId })` is called from `placeBid` and `buyNow` after the transaction, wrapped in try / catch: a failure is logged and never fails the bid.

| Reason | Score | Rule |
|---|---|---|
| `SHARED_DEVICE` | +50 | a bidder `Session.deviceId` equals a seller `Session.deviceId` (sessions with `lastUsedAt` in the last 30 days) |
| `SHARED_IP` | +30 | the same for `Session.ip` (null never matches) |
| `NEW_ACCOUNT_SINGLE_SELLER` | +20 | the bidder account is under 7 days old and every one of their bids is on this seller's auctions |

Score >= 50 flags: the signal is upserted (keep the max score, merge the reasons) and every active SUPER_ADMIN gets `shill-flag` (`dedupeKey shill-flag:<auctionId>:<bidderId>:<adminId>`, url `/admin/risk`).

## Daily scan (`runRiskScan`)

Over the bids of the last 90 days (up to 100,000 rows, logged when truncated), per (bidder, seller):

| Reason | Score | Rule |
|---|---|---|
| `CONCENTRATION` | +40 | the bidder has >= 5 bids and more than 70% of them are on this seller |
| `NEVER_WINS` | +30 | the bidder bid on >= 3 of this seller's ENDED auctions and won none (outbid every time) |

Pairs scoring >= 50 (both reasons) are upserted against the seller's latest auction the bidder bid on, with the same notification. Idempotent: re-runs upsert the same rows. Lambda `riskScan` is `rate(1 day)`; the local dev server does not schedule it.

**Retention:** the live check reads 30 days of `Session` rows. `retentionPurge` deletes sessions idle longer than `max(30 days, refresh-token lifetime)` (`SESSION_INACTIVE_RETENTION_DAYS`), so the window is always available.

## Admin endpoints (SUPER_ADMIN)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/risk?status=open\|reviewed&page&pageSize` | default `open` (`reviewedAt` null, highest score first); `reviewed` newest review first. Items `{ id, auction { id, title }, bidder { id, name, email }, seller { id, name, email }, score, reasons: string[], createdAt, updatedAt, reviewedAt, outcome, note }` |
| PATCH | `/admin/risk/:id` | `{ outcome: 'DISMISSED' \| 'ACTION_TAKEN', note? <= 500 }` -> `{ signal }`; sets `reviewedAt`, `reviewedById`. 404 `RISK_SIGNAL_NOT_FOUND`, 409 `RISK_ALREADY_REVIEWED` |

## Tests

`risk/risk.test.ts` (scoring, shared device / ip / new account, threshold, upsert merge, scan rules and job), `admin/risk/admin-risk.test.ts` (list, review, validation), bidding HTTP test (a failing check never fails the bid), guards / validation HTTP matrices.
