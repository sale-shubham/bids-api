# Documentation sync rules (NobleBid API)

> **NON-NEGOTIABLE.** Any code change MUST land with its docs update in the same commit. Stale docs are treated as a bug.

This file extends `.claude/RULES.md §1` with a concrete additions / modifications / removals matrix.

## Before editing

| Change area | Read first |
|---|---|
| Route / service / middleware for a feature | `readme/flows/<feature>.md` |
| Shared util / helper | `readme/methods/<domain>.md` |
| Boot sequence, env, middleware order | `readme/ARCHITECTURE.md` |
| Deployment / serverless config | `readme/flows/deployment.md` |

## Additions trigger

| You added | You MUST also update |
|---|---|
| New route (endpoint) | Endpoints table in `readme/flows/<feature>.md` |
| New service method | Flow doc |
| New feature (new resource: routes + service + validation) | **Create `readme/flows/<feature>.md`** + register row in `CLAUDE.md` README registry |
| New middleware | `readme/ARCHITECTURE.md` request-lifecycle section |
| New Joi validator schema | `readme/methods/validation.md` table + the relevant flow doc |
| New env var | `src/core/config/env.ts` + `.env.production.example` + `readme/methods/security.md` env table |
| New Prisma model | `prisma/schema.prisma` + `readme/flows/<feature>.md` schema section |
| New rate-limit tier | `src/core/middleware/rateLimit.ts` + `readme/methods/security.md` |
| New deployment step | `readme/flows/deployment.md` |
| New standalone skill | `.claude/skills/<skill>/SKILL.md` + skills table in `CLAUDE.md` |
| New / changed agent behavior | `AGENTS.md` |

## Modifications trigger

| You changed | You MUST also update |
|---|---|
| Behavior of an existing flow | `readme/flows/<feature>.md` |
| Signature of a shared util | `readme/methods/<domain>.md` |
| Auth/refresh token shape | `readme/flows/auth.md` |
| Route mounting | `readme/flows/routing.md` |

## Removals trigger

| You removed | You MUST also do |
|---|---|
| Endpoint / feature | Delete the section / row in the flow doc; if whole feature → delete file + remove from `CLAUDE.md` registry |
| Util | Delete its section in `readme/methods/<domain>.md` |
| Env var | Remove from `env.ts`, `.env.production.example`, env table |

## Hard rules

- **No per-directory or per-module READMEs.** All documentation in `readme/`.
- **One feature per file.** Never merge two features into one doc.
- **Register before merge.** New doc files must appear in `CLAUDE.md` README registry in the same commit.
