# Validation

## validate() middleware

`src/core/middleware/validate.ts`

```typescript
validate(schema: Joi.Schema, source: 'body' | 'query' | 'params' = 'body'): ValidateMiddleware
```

- Validates `req[source]` against Joi schema
- Options: `abortEarly: false`, `convert: true`, `stripUnknown: true`
- On error: 400 + `{ success: false, error: { code: 'VALIDATION_ERROR', message: string, details: [{ field, message }] } }` (matches the standard `errorHandler` envelope)
- On success: overwrites `req[source]` with converted/stripped value

## Schema conventions

| Rule | Example |
|---|---|
| Strings trimmed | `.trim()` |
| Emails lowercased | `.lowercase().email()` |
| Enums | `Joi.string().valid('A', 'B')` |
| Optional fields | `.optional()` or `.allow(null, '')` |
| Default values | `.default(20)` |
| Integer numbers | `Joi.number().integer()` |
| Regex | `.pattern(/^[A-Z]+$/)` |

## Per-source usage

```typescript
// Body (default)
router.post('/', validate(createSchema), handler);

// Query string
router.get('/', validate(listQuery, 'query'), handler);

// URL params
router.get('/:id', validate(paramsSchema, 'params'), handler);
```

## Notable schemas

- `push.validation.ts` (2026-11-03): `subscribeSchema` is exactly the browser's `PushSubscription.toJSON()` — `endpoint` (https-only URI, ≤2000), optional `expirationTime`, `keys.p256dh`/`keys.auth` (≤255) — and `unsubscribeSchema` is `{ endpoint }`. See `readme/flows/push-notifications.md`.

## Joi-only rule

No Zod, no Yup. Every request validation uses `Joi` + the `validate()` middleware. (Some route files define their Joi schemas inline rather than in a separate `*.validation.ts` — e.g. payments, packages, leads — but still go through `validate()`.)

---
*Last updated: 2026-11-03 (`push.validation.ts` schemas)*
*Previously: 2026-06-26*

*Also 2026-11-02: `optionsQuerySchema` and `excludeIdsSchema` (`src/core/http/pagination.ts`) — shared Joi schemas for dropdown option endpoints (`q` may be empty, `page`/`pageSize` opt-in with no defaults, `excludeIds` comma/repeated list). See [http.md](./http.md).*
