# Notification preferences and WhatsApp

Code: `src/modules/notification-preferences/` (service, validation; routes live in `members.routes.ts`), catalogue + channel rules in `src/modules/notify/notify.catalogue.ts`, delivery in `notify.service.ts`, provider in `src/providers/whatsapp/`.

## Schema

`NotificationPreference { memberId -> Member (cascade), type, email default true, push default true, whatsapp default false, updatedAt, @@id([memberId, type]) }`; `Member.whatsappOptInAt DateTime?`. A missing row means the defaults.

## Endpoints (active member)

| Method | Path | Notes |
|---|---|---|
| GET | `/members/me/notification-preferences` | `{ items: [{ type, label, group, email, push, whatsapp, emailLocked, whatsappCapable }], whatsappOptIn, phoneVerified }`. Groups: Bidding, Selling, Payments, Community, Account, Admin; admin-only types (`report-filed`, `shill-flag`) only for SUPER_ADMIN |
| PUT | `/members/me/notification-preferences` | `{ items: [{ type, email, push, whatsapp }] }` (non-empty, unique types, booleans); unknown type 400 `VALIDATION_ERROR`, admin-only type for a non-admin 400. `email: false` on a mandatory type is ignored (stored as true); `whatsapp: true` on a non-capable type is stored as false. Returns the same shape as GET |
| POST | `/members/me/whatsapp` | `{ optIn }` -> `{ whatsappOptIn }`; opting in needs a verified phone (409 `PHONE_NOT_VERIFIED`) |

`GET /members/me` carries `whatsappOptIn: boolean`. Changing or clearing the phone (`PATCH /members/me`), or verifying a different number, clears `whatsappOptInAt`.

## Channel rules

- In-app inbox rows and the live WebSocket event are always created.
- Mandatory email (`emailLocked`): all `sale-*`, `deposit-*`, `commission-due`, `commission-paid`, `strike-issued`, `account-suspended`, `auction-won`, `second-chance-offer`.
- Email and Web Push follow the preference (default on). WhatsApp needs: preference on, `whatsappOptInAt`, verified phone (10-digit mobile, sent as `+91<phone>`), and a capable type: `outbid`, `ending-soon`, `auction-won`. WhatsApp is sent after the inbox row exists; a failure is logged and never fails or retries the message.
- Dedupe semantics are unchanged (`notifications.md`).

## WhatsApp provider

`whatsappProvider.sendTemplate({ to (E.164), template, language: 'en', params })`. Drivers by `WHATSAPP_DRIVER`: `stub` (default, logs the masked number and template name) and `meta` (`POST https://graph.facebook.com/<WHATSAPP_API_VERSION>/<WHATSAPP_PHONE_NUMBER_ID>/messages`, bearer `WHATSAPP_TOKEN`, body `{ messaging_product: 'whatsapp', to, type: 'template', template: { name, language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text }] }] } }`).

Env: `WHATSAPP_DRIVER`, `WHATSAPP_TOKEN` (secret), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` (`v21.0`), `WHATSAPP_TEMPLATE_OUTBID|ENDING_SOON|AUCTION_WON|SALE_PAYMENT_DUE`. Boot refuses `meta` in production without token and phone number id.

### Setup (Meta)

1. Create a Meta Business account, add a WhatsApp Business Account and a phone number; note the phone number id.
2. Create a system user and a permanent access token with `whatsapp_business_messaging`; store it as the `WHATSAPP_TOKEN` secret.
3. Create and get approved four **utility** templates, language `en`, body only, with exactly three variables in this order: `{{1}}` item title (clipped to 60 chars), `{{2}}` amount (INR, Indian grouping, e.g. `Rs 1,23,456`), `{{3}}` link path (e.g. `/auctions/<id>`):

| Template (default name) | Sent for | Amount |
|---|---|---|
| `nb_outbid` | `outbid` | the new highest bid |
| `nb_ending_soon` | `ending-soon` | current bid (starting bid when no bids) |
| `nb_auction_won` | `auction-won` (commission mode) | final bid |
| `nb_sale_payment_due` | `auction-won` in checkout mode (pay within 3 days) | final bid |

4. Set the variables per stage (`deployment.md`) and `WHATSAPP_DRIVER=meta`.

## Tests

`notification-preferences/notification-preferences.test.ts` (catalogue, GET defaults, PUT rules, opt-in, phone change), `notify/notify.test.ts` (channel matrix, WhatsApp failure), `providers/whatsapp/whatsapp.test.ts` (request shape), HTTP guards and validation.
