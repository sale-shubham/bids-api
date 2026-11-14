# .claude/RULES.md — Standing Instructions

Read this file at the start of every session.
These rules apply to every task in this repository without exception.

---

## 1. Documentation sync (mandatory)

- All documentation lives in the `readme/` directory at the project root.
- Before touching a file in any directory, read the corresponding flow-specific README in `readme/`.
- After any code change, update the corresponding flow-specific README in `readme/`.
- After adding a new feature or flow, update `readme/flows/<feature>.md` or create a new flow-specific document and register it in `CLAUDE.md`.
- `CLAUDE.md` must be updated whenever a new flow README is added.
- **No per-directory or per-module READMEs**: do not create `README.md` files in inner folders. All documentation in `readme/`.
- Full matrix: `docs/DOC_SYNC.md`.

---

## 2. Package hygiene

- Never add two packages that solve the same problem.
  - Validation: use **Joi** only (not zod, not yup — zod was removed).
  - HTTP client: no axios — backend makes no outbound HTTP (except Razorpay SDK).
  - Date/time: native `Date` only.
  - ORM: Prisma only.
- Do not modify `package.json` without explicit instruction.

---

## 3. Git workflow

### Default branches
- `main` — production-ready, protected
- `dev` — integration branch; all features merge here first

### Starting a new feature
1. Check out from `dev`: `git checkout dev && git pull origin dev`
2. Create a feature branch: `git checkout -b feature/<name>`
3. Work on the feature branch only.

### Committing
- **Never commit on behalf of the user.** Stop and let the user review the diff before committing.
- Write conventional commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`
- Include a short body describing *why*, not just *what*.

### Pull requests
- Target branch is always `dev` (never `main` directly).
- PR title format: `[TYPE] Short description`
- **Never self-merge.**

---

## 4. PR review instructions

PR/diff review runs through the vendored official Claude Code plugins.

1. **Primary:** run `/code-review` for any PR or working-tree diff.
2. **Deeper pass:** use `/review-pr` — specialized agents (silent-failure-hunter, type-design-analyzer, pr-test-analyzer, comment-analyzer, code-simplifier).
3. **Project-specific gates (always check):**
   - Missing Joi `validate()` on body/query routes.
   - AppError not thrown (raw `throw new Error()` instead).
   - `asyncHandler` missing on route handlers.
   - Missing README/doc updates per the doc-sync policy (§1).

---

## 5. GitHub tickets

When asked to create a ticket (GitHub issue):
- Title: concise, action-oriented
- Body: **Context**, **Acceptance criteria**, **Notes** (optional)
- When creating a PR for work with a ticket, link with `Closes #N`.

---

## 6. Code style

- Follow the existing pattern in the file you are editing.
- TypeScript: no `any` unless unavoidable; use explicit types.
- No commented-out code left in commits.
- No per-file docstrings or multi-line comment blocks — one short line max.
- **Reuse before creating.** Before writing a new helper, middleware, or service function, search `src/core/` (`http/`, `middleware/`, `errors/`, `prisma/`, `config/`) and sibling modules under `src/modules/` for one that already does the job (e.g. `ok`/`paginated`, `AppError`/`Conflict`/`NotFound`, `asyncHandler`, `validate`, `offsetArgs`, key-generation like `generateKey`/`slugify`). Only write a new one if nothing fits — and if the need is generic (not one-module-specific), add it to `src/core/` rather than duplicating it inline in a module. Never copy-paste an existing helper's logic under a new name.

---

## 7. Environment and config

- Never hard-code secrets or API keys.
- All config through `src/core/config/env.ts`.
- New env vars must be added to `env.ts` AND `.env.production.example`.

---

## 8. API-specific hard rules

- **Validation** — every route body/query uses `validate(schema, source)` (`src/core/middleware/validate.ts`) with Joi schema from the module's `*.validation.ts`.
- **Auth** — protected routes use `authenticate` + `requireRole`/`requireApprovedMember` from `src/core/middleware/auth.ts`.
- **Error handling** — throw `AppError` for known errors. `asyncHandler` wraps all route handlers.
- **Response** — use `ok(res, data)` and `paginated(res, items, meta)` from `src/core/http/response.ts`.
- **Prisma client** — singleton from `src/core/prisma/client.ts`. Never `new PrismaClient()` elsewhere.
- **Machine keys/slugs** — any unique machine identifier (`key`, `slug`, etc.) on a model that also has a human label (`name`/`label`) is **always generated server-side** from that label (see `generateKey` in `specifications.service.ts`, `slugify` in `plans.routes.ts`). Never accept it in the create Joi schema, never accept it on update, never require the frontend to send or display it. Collision → `Conflict` (409).

---

## 9. Reuse audit (grep before writing new code)

Before adding a helper/middleware/service function, check it doesn't already exist under a different name:

```bash
grep -rn "export function <name>\|export const <name>" src/core/ src/modules/
```

If something close already exists, extend or parameterize it instead of adding a near-duplicate.

---

## 10. Session bootstrap (mandatory)

RULES.md is auto-injected at the start of every session via the `SessionStart` hook in `.claude/settings.local.json`.

---

*Last updated: 2026-07-17*
