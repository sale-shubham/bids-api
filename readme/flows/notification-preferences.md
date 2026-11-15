# Notification preferences

Code: `src/modules/notification-preferences/` (service, validation; routes live in `members.routes.ts`), catalogue + channel rules in `src/modules/notify/notify.catalogue.ts`, delivery in `notify.service.ts`.

## Schema

`NotificationPreference { memberId -> Member (cascade), type, email default true, push default true, updatedAt, @@id([memberId, type]) }`; a missing row means the defaults.

## Endpoints (active member)

| Method | Path | Notes |
|---|---|---|
| GET | `/members/me/notification-preferences` | `{ items: [{ type, label, group, email, push, emailLocked }] }`. Groups: Bidding, Selling, Payments, Community, Account, Admin; admin-only types (`report-filed`, `shill-flag`) only for SUPER_ADMIN |
| PUT | `/members/me/notification-preferences` | `{ items: [{ type, email, push }] }` (non-empty, unique types, booleans); unknown type 400 `VALIDATION_ERROR`, admin-only type for a non-admin 400. `email: false` on a mandatory type is ignored (stored as true). Returns the same shape as GET |

## Channel rules

- In-app inbox rows and the live WebSocket event are always created.
- Mandatory email (`emailLocked`): all `sale-*`, `deposit-*`, `commission-due`, `commission-paid`, `strike-issued`, `account-suspended`, `auction-won`, `second-chance-offer`.
- Email and Web Push follow the preference (default on). WhatsApp alerts were removed (`docs/DECISIONS.md` D16): there is no WhatsApp channel, column or provider.
- Dedupe semantics are unchanged (`notifications.md`).

## Tests

`notification-preferences/notification-preferences.test.ts` (catalogue, `resolveChannels`, GET defaults, PUT rules), `notify/notify.test.ts` (email / push channel matrix), HTTP guards and validation.
