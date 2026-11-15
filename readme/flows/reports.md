# Reports and moderation flow

Members report auctions, members, reviews and lot questions; Super Admins work a moderation queue. Code: `src/modules/reports/` (`reports.{routes,controller,service,validation}.ts`), `src/modules/admin/reports/`.

## Schema

`Report { id, reporterId -> Member, targetType (AUCTION|MEMBER|REVIEW|QUESTION), targetId, reason (COUNTERFEIT|PROHIBITED|MISLEADING|SPAM|ABUSE|OTHER), details?, status (OPEN|ACTION_TAKEN|DISMISSED, default OPEN), resolvedById?, resolvedAt?, note?, createdAt }`; `@@unique([reporterId, targetType, targetId])`, `@@index([status, createdAt])`, `@@index([targetType, targetId])`. `targetId` is a plain string (no FK, so a removed target keeps its report).

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/reports` | active member, `reportLimiter` (20 / day / member) | `{ targetType, targetId (1-60), reason, details? <= 1000 }` -> 201 `{ report: { id, status } }` |
| GET | `/admin/reports` | SUPER_ADMIN | `status`, `targetType`, `page`, `pageSize` (max 100) -> paginated items `{ id, targetType, targetId, reason, details, status, createdAt, resolvedAt, note, reporter { id, name, email }, target { label, url }, openCountForTarget, priority }`, newest first |
| PATCH | `/admin/reports/:id` | SUPER_ADMIN | `{ status: 'ACTION_TAKEN'\|'DISMISSED', note? <= 500, applyToAllOpenForTarget? }` -> `{ report: { id, status, resolvedAt, note }, resolvedCount }` |

## Rules

- Target must exist: auction not soft-deleted, member active, review, question; else 404 `REPORT_TARGET_NOT_FOUND`.
- Reporting yourself or your own auction (seller) / review (author) / question (asker): 400 `INVALID_REPORT`.
- Duplicate (same reporter + target): 409 `ALREADY_REPORTED` (unique-constraint P2002).
- On create every active SUPER_ADMIN gets notification type `report-filed` (dedupe `report-filed:<reportId>:<adminId>`, url `/admin/reports`, `data { reportId, targetType, reason, targetLabel }`); a notification failure never fails the report.
- Admin list `target`: auction title -> `/auctions/<id>`; member name -> `/sellers/<id>`; review comment snippet -> `/admin/reviews`; question snippet -> `/auctions/<auctionId>`; a removed target shows `{ label: '(removed)', url: null }`. `openCountForTarget` = OPEN reports on the same target; `priority` = `HIGH` when it is >= 3, else `NORMAL`.
- Resolving: only an OPEN report (409 `REPORT_ALREADY_RESOLVED` otherwise; 404 unknown). `applyToAllOpenForTarget` resolves every OPEN report on the same target in one update (`resolvedCount`). Resolution only records the outcome; the moderation action itself uses the existing endpoints (`DELETE /auctions/:id` cancel, `PATCH /admin/members/:id` suspend, `PATCH /admin/reviews/:id` hide, `POST /questions/:id/hide`).

## Legal page

`prohibited-items` ("Prohibited items") is a legal page slug (`legal-pages.md`); its default body is seeded by `prisma/seed.ts` from `prisma/legal-seed-content.ts` (run `npm run prisma:seed` once; existing edited pages are never overwritten).

## Tests

`admin/reports/admin-reports.test.ts` (priority, target labels, resolve-all), `__tests__/http/trust.http.test.ts` (create rules: not found, self, duplicate, admin notifications) and the guards / validation HTTP matrices.
