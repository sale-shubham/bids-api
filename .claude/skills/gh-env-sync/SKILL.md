---
name: gh-env-sync
description: Push the GitHub Actions secrets/vars referenced in .github/workflows/deploy_serverless.yml to the repo (via gh CLI). Use when asked to sync/upload/set deploy env vars or secrets into GitHub.
---

# Skill: gh-env-sync

Syncs GitHub Actions secrets/variables into this repo based on what
`.github/workflows/deploy_serverless.yml` **actually references right now** —
never a hardcoded list. The workflow is the single source of truth for which
names exist; re-parse it every run so newly added vars (e.g. a future
`SES_AWS_REGION`-style addition) are picked up automatically without editing
this skill.

## Hard rules

- **Never print a secret value** in chat, in a tool-call argument shown to the
  user, or in any summary. Names are fine to show; values from `secrets.*`
  are not. Values from `vars.*` are not secret and may be shown.
- **Never read the real dev `.env`** as the source of prod values — it holds
  dev-only credentials and is very likely wrong for `_PROD`-suffixed names.
  Always ask the user for an explicit source file (or paste) for the actual
  values to push.
- **Confirm before writing** — this mutates shared GitHub state visible to
  the whole repo/org. List exactly which names (not values) are about to be
  set/overwritten and the target repo, and get explicit go-ahead, same bar as
  a force-push or a destructive git op.
- **Clean up scratch files** containing secret material immediately after
  use (`rm` the temp env file), even on error paths.

## Steps

1. **Parse the workflow file** for every reference to `secrets.<NAME>` and
   `vars.<NAME>` inside `${{ ... }}` expressions:
   ```bash
   grep -oE '\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}' .github/workflows/deploy_serverless.yml \
     | sed -E 's/.*secrets\.([A-Z0-9_]+).*/\1/' | sort -u
   grep -oE '\$\{\{\s*vars\.[A-Z0-9_]+\s*\}\}' .github/workflows/deploy_serverless.yml \
     | sed -E 's/.*vars\.([A-Z0-9_]+).*/\1/' | sort -u
   ```
   These two lists (`SECRET_NAMES`, `VAR_NAMES`) are the full, current
   contract — including `_PROD`-suffixed names, which are distinct entries,
   not a suffix to strip. Do not consult any other file to decide what's
   "supposed" to exist; the workflow's own references are authoritative.

2. **Resolve the target repo**: `gh repo view --json nameWithOwner -q .nameWithOwner`.
   If `gh` isn't authenticated or the repo can't be resolved, stop and ask.

3. **Show the two name lists to the user** (names only) and ask which ones
   they want to push this run — default to "all", but let them scope to a
   subset (e.g. just the new `EMAIL_*`/`SES_AWS_*`/`LOGO_URL` additions).

4. **Get the values.** Ask the user for a dotenv-formatted source (a file
   path, or values pasted directly) covering the selected names. Do not
   default to `.env`. If they hand you a file, read it yourself to check
   coverage — report which of the selected names are present vs. missing —
   but never echo the values back into chat.

5. **Build one scratch dotenv file per target** (secrets vs vars), containing
   only `KEY=VALUE` lines for names actually selected AND present in the
   source — write it under the job's tmp dir (see the environment's scratch
   directory, not `/tmp` directly, if running in a background job), e.g.
   `$SCRATCH/gh-secrets.env` / `$SCRATCH/gh-vars.env`.

6. **Push via `gh` CLI**, scoped to the resolved repo:
   ```bash
   gh secret set --repo "$REPO" --env-file "$SCRATCH/gh-secrets.env"
   gh variable set --repo "$REPO" --env-file "$SCRATCH/gh-vars.env"
   ```
   If the installed `gh` version doesn't support `--env-file` on one of
   these (check `gh secret set --help` / `gh variable set --help` first),
   fall back to one call per name:
   ```bash
   gh secret set NAME --repo "$REPO" --body "$VALUE"
   gh variable set NAME --repo "$REPO" --body "$VALUE"
   ```
   still without ever printing `$VALUE` in the transcript (pipe it in, don't
   interpolate it into a visible command string).

7. **Shred the scratch files** immediately after the push
   (`rm -f "$SCRATCH/gh-secrets.env" "$SCRATCH/gh-vars.env"`), success or failure.

8. **Report a summary**: which names were set (secrets and vars, separately),
   which were skipped because the source didn't cover them, and the target
   repo — names only, never values.

## Notes

- `secrets.*` and `vars.*` are two separate GitHub stores (`gh secret set` vs
  `gh variable set`) — don't conflate them even though the workflow's own
  `$GITHUB_ENV` lines look similar for both.
- Names like `AWS_ACCESS_KEY_ID_PROD` vs `AWS_ACCESS_KEY_ID` are genuinely
  distinct GitHub secrets, driven by the workflow's own `main` vs `dev`
  branch if/else — both need real values if both branches deploy.
- Some names (`AWS_REGION`, `JWT_SECRET`, `REFRESH_TOKEN_SECRET`,
  `SES_AWS_REGION`, etc.) are set once, shared across both `dev` and `prod`
  stages in the workflow's current design — that's an existing property of
  the workflow, not something this skill should "fix" by inventing `_PROD`
  variants that don't exist in the file.
- If the user asks to add a brand-new env var to the deploy pipeline, that's
  a code change to `serverless.yml` + this workflow file first (see
  `readme/flows/deployment.md`) — this skill only syncs what's already
  referenced, it doesn't decide what should be referenced.
