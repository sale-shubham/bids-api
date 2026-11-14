# Notifications flow

Code: pipeline in `src/modules/notify/` (`notify.queue.ts`, `notify.service.ts`, `notify.worker.ts`, `notify.content.ts`, `notify.types.ts`); in-app inbox API in `src/modules/notifications/`; email templates in `src/templates/` (`outbid`, `auction-won`, `auction-sold`, `auction-unsold`, `commission-due`, each `.ejs` + `.txt.ejs`, sharing `_head` / `_foot` / `_contact` partials; links use `env.app.url`).

## In-app endpoints (auth required)

| Method | Path | Response |
|---|---|---|
| GET | `/notifications` | `paginated({ id, type, title, body, url, readAt, createdAt }[])`, newest first (`page`, `pageSize`) |
| GET | `/notifications/unread-count` | `{ count }` |
| POST | `/notifications/:id/read` | `{ id }`; 404 if it is not the caller's; idempotent |
| POST | `/notifications/read-all` | `{ count }` marked |

Model `Notification { id, memberId, type, title, body, url, data Json?, dedupeKey @unique, readAt?, createdAt }`, index `(memberId, readAt, createdAt)`, cascade on member delete.

## Pipeline

`enqueueNotification({ type, memberId, auctionId?, data?, dedupeKey })`:
- `NOTIFY_QUEUE_URL` set (Lambda) -> SQS `SendMessage`; the `notifyWorker` Lambda (batch 10, `ReportBatchItemFailures`, reserved concurrency 5) runs `processSqsBatch`, which returns `{ batchItemFailures: [{ itemIdentifier: messageId }] }` for failed records (after 3 receives SQS moves them to NotifyDLQ).
- Unset (local dev) -> `processNotification` inline; errors are logged, never thrown. Enqueue itself never throws (a notification must not fail a bid or the close job).

Dedupe keys: `outbid:<bidId>:<memberId>`, `auction-won:<auctionId>`, `auction-sold:<auctionId>`, `commission-due:<auctionId>`, `auction-unsold:<auctionId>:<endedAtMs>` (the timestamp lets a republished auction notify again).

`processNotification` order (idempotent, retry-safe):
1. dedupeKey already has a row -> `duplicate`, stop.
2. Member missing or `isActive = false` -> `skipped` (nothing is sent or stored).
3. Send the email. In the worker an email failure is rethrown here, before any row exists, so SQS retries the whole message. Inline it is logged and delivery continues.
4. Insert the `Notification` row. A unique violation (concurrent duplicate) = `duplicate`.
5. `sendPushToMember(memberId, { type, title, body, url })` only if this call inserted the row.

Accepted trade-offs: if the email send succeeded but the insert fails, the retry sends the email a second time (a rare duplicate email is preferred over a lost one); if the email fails permanently the in-app row is not created and the message ends in the DLQ.

Contact details for `auction-won` (seller) and `auction-sold` (winner) are loaded at processing time, never put on the queue. Amounts are formatted as INR (`en-IN`) by `formatInr`.
