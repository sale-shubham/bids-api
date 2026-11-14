# security-guidance

Security review for Claude-generated code. Three layers:

1. **Pattern warnings** — instant regex-based reminders on `Edit`/`Write` for ~25 known-dangerous patterns (`yaml.load`, `torch.load(weights_only=False)`, `pickle.load` on untrusted data, raw `innerHTML`, hardcoded secrets, etc.).
2. **LLM diff review** — when Claude finishes a turn, the plugin sends the diff to a fast LLM call (Opus 4.7 by default) and feeds high-severity findings back to Claude so it can fix them before you see the response.
3. **Agentic commit review** — on `git commit`, an SDK-driven reviewer reads related files (`Read`/`Grep`/`Glob`) to trace data flow across the codebase, catching multi-file vulnerabilities pattern matching misses (IDOR, auth bypass, cross-file SSRF).

Findings cover common web-vulnerability classes — injection, XSS, SSRF, hardcoded secrets, IDOR, auth bypass, unsafe deserialization, and path traversal among others.

## Install

```
/plugin install security-guidance@claude-plugins-official
```

Marketplace ships enabled by default in Claude Code — no setup beyond having the CLI itself.

## Prerequisites

- Claude Code CLI ≥ v2.1.144
- Python 3.8+ on `PATH` (`python3`, `python`, or `py -3` — the plugin picks the first that works)
- A working API path (subscription, API key, or 3P provider config)

## Configuration

All configuration is via environment variables. None are required for default behavior.

### Selecting a model

```bash
# 1P / gateway: a canonical model id
SECURITY_REVIEW_MODEL=claude-opus-4-7   # default

# Bedrock: use the inference-profile id
SECURITY_REVIEW_MODEL=us.anthropic.claude-opus-4-7

# Vertex: use the Vertex date-tag form
SECURITY_REVIEW_MODEL=claude-opus-4-7@20260218
```

`SECURITY_REVIEW_MODEL` controls the LLM diff review. `SG_AGENTIC_MODEL` (same syntax) controls the agentic commit reviewer; defaults to the same model.

### Enabling/disabling layers

| Variable | Default | What it does |
|---|---|---|
| `SECURITY_GUIDANCE_DISABLE=1` | unset | Kill switch — disables the entire plugin |
| `ENABLE_PATTERN_RULES=0` | on | Disable layer 1 (regex pattern warnings) |
| `ENABLE_CODE_SECURITY_REVIEW=0` | on | Disable all LLM reviews (Stop hook + commit/push) |
| `ENABLE_STOP_REVIEW=0` | on | Disable only the Stop-hook diff review, keeping commit/push reviews. Useful for multi-agent / shared-worktree setups where another agent can move HEAD between a worker's turns |
| `ENABLE_COMMIT_REVIEW=0` | on | Disable layer 3 (agentic commit review) |

### Higher-recall mode

```bash
SG_DUAL_OR=on   # default off
```

Runs two parallel review calls and unions the findings. Catches a few percentage points more vulnerabilities in our testing, at roughly 2× the API cost per review. Most users don't need it.

## Org-specific policies

Drop a `claude-security-guidance.md` in any of:

- `~/.claude/claude-security-guidance.md` — user-wide rules
- `<project>/.claude/claude-security-guidance.md` — project rules, intended to be committed
- `<project>/.claude/claude-security-guidance.local.md` — local overrides, intended to be `.gitignore`'d

All three are loaded and concatenated into the LLM diff review's prompt in the order user → project → project-local. If the combined size exceeds the 8 KB prompt budget, the tail is truncated, so user-wide rules are kept and project-local rules are dropped first. The agentic commit reviewer (layer 3) does not currently read this file. Example:

```markdown
# NobleBid API security rules

- All database queries must go through Prisma — never raw SQL with user-controlled input.
- JWT verification must use `authenticate` middleware from `src/core/middleware/auth.ts`.
- File upload paths must be validated against allowed extensions and size limits.
- Razorpay webhook signatures must always be verified before processing.
```

Built-in rules cover common web-vulnerability classes without it — `claude-security-guidance.md` is for things specific to your codebase that the model can't infer.

## Privacy and data handling

The plugin sends data to a model endpoint to perform its reviews. Specifically, each Stop-hook diff review transmits the changed file paths, the diff hunks, and the relevant file contents in the diff; each agentic commit review additionally transmits any files the reviewer pulls in via `Read`/`Grep`/`Glob` while tracing data flow. Your `claude-security-guidance.md` contents (user, project, and local) are appended to the prompt on every review, so don't put secrets in it.

## Limitations

This is a best-effort assistive tool, not a guarantee. Treat findings as suggestions, not as a substitute for human code review, SAST/DAST, dependency scanning, or pen-testing.

## Troubleshooting

**Plugin doesn't seem to fire** — check that hook activity shows in debug logs. Run Claude Code with `--debug-file /tmp/claude/debug.txt` and grep for `security_reminder_hook`.

**Review never finds anything** — verify your API path works. On 3P providers, check `SECURITY_REVIEW_MODEL` is set to a provider-specific id.

**Too many false positives** — drop `SECURITY_REVIEW_MODEL` to a cheaper model (`claude-sonnet-4-6`) and re-evaluate.
