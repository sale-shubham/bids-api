# Lot Q&A flow

Code: `src/modules/questions/questions.{routes,controller,service,validation,rules}.ts`. A bidder asks a public question on a lot; the seller answers once. Text is stored as plain text (clients render it as text; email templates use escaped `<%= %>`).

## Schema

`AuctionQuestion { id, auctionId -> Auction (cascade), askerId -> Member, question, answer?, answeredAt?, hiddenAt?, createdAt }`, index `(auctionId, createdAt)`.

## Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/auctions/:id/questions` | public, optional auth | `{ items: QuestionDTO[] }`, newest first, max 100, never hidden ones. 404 `AUCTION_NOT_FOUND` (cancelled ones only for the seller / SUPER_ADMIN) |
| POST | `/auctions/:id/questions` | BIDDER (active), `qaLimiter` | `{ question: trimmed 5..500 }` -> 201 `{ question }` |
| POST | `/questions/:id/answer` | AUCTIONEER / SUPER_ADMIN (active), must be the auction's seller | `{ answer: trimmed 1..1000 }` -> `{ question }` |
| POST | `/questions/:id/hide` | AUCTIONEER / SUPER_ADMIN (active): the auction's seller or SUPER_ADMIN | `{ ok: true }`, idempotent |

`QuestionDTO = { id, auctionId, question, answer|null, answeredAt|null, createdAt, askerLabel (bidderLabel), isMine }`.

## Rules

- Visibility (`visibilityWhere`): everyone sees answered questions; the asker also sees their own pending ones; the auction's seller and SUPER_ADMIN see all pending. Hidden rows are never returned.
- Ask: the asker must not be the seller and the auction must be effectively SCHEDULED or LIVE, else 403 `QUESTION_NOT_ALLOWED`. Notifies the seller `question-asked` (dedupe `question-asked:<id>`, url `/auctions/<id>`).
- Answer: only the auction's seller (403 `FORBIDDEN` otherwise, SUPER_ADMIN included); hidden or unknown -> 404 `QUESTION_NOT_FOUND`; already answered -> 409 `ALREADY_ANSWERED` (race-safe via `updateMany` with `answer: null`). Notifies the asker `question-answered` (dedupe `question-answered:<id>`).
- Hide sets `hiddenAt`; repeated calls are no-ops.
- `qaLimiter` (`src/core/middleware/rateLimit.ts`): 10 per hour per member, Postgres store prefix `rl:qa:`.

## Tests

`questions/questions.test.ts` (visibility matrix, ask rules, answer once, hide), HTTP guards and validation matrices.
