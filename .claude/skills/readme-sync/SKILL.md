---
name: readme-sync
description: Checklist for keeping readme/ docs in sync with code after any change. Enforced automatically by the doc-sync Stop hook.
---

# Skill: readme-sync

Use after any code change to ensure READMEs are in sync.

## Checklist

- [ ] Read the relevant doc in the matching `readme/` subfolder for every flow/method change made:
  - Logic or data flow changed → `readme/flows/<feature>.md`
  - Shared utility/helper changed → `readme/methods/<domain>.md`
- [ ] For each doc touched, verify:
  - Does the **Flow** section reflect current data pathways?
  - Does the **Methods / Exports** section reflect current shared helpers?
  - Are new **Dependencies** documented?
  - Are stale steps or logic removed?
- [ ] If new feature or flow added → create `readme/flows/<feature>.md`. Do NOT append to another feature's file.
- [ ] If new utility domain added → create `readme/methods/<domain>.md`.
- [ ] Update the *Last updated* line in every document touched.

## File naming rules

- `readme/flows/` — one file per feature: `auth.md`, `listings.md`, `payments.md`
- `readme/methods/` — one file per utility domain: `validation.md`, `prisma.md`, `http.md`

Never put two unrelated features in the same file.

## Flow README template (for `readme/flows/` directory)

```markdown
# <Feature name>

## Purpose
<!-- What this flow/process is responsible for -->

## Steps
<!-- Sequence of operations and logic -->

## Data Pathways
<!-- How data enters and exits this flow -->

## Dependencies
<!-- Major packages or modules this flow relies on -->

## Notes
<!-- Edge cases, known limitations, gotchas -->

---
*Last updated: YYYY-MM-DD*
```

## Method README template (for `readme/methods/` directory)

```markdown
# <Domain name> Methods

## Purpose
<!-- What utilities this domain covers -->

## Methods

### `methodName(params)`
<!-- Description, params, return value -->

## Notes
<!-- Edge cases, known limitations -->

---
*Last updated: YYYY-MM-DD*
```

### Rule: No per-directory or per-module READMEs
Never create `README.md` files in inner folders or for individual modules. All documentation must stay in the `readme/` subfolders and focus on flows and patterns.
