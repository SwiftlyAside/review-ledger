# review-ledger

A Claude Code plugin that turns one-way code review into a converging loop. Claude authors, Codex (`gpt-5.6-sol` by default) reviews, and a per-repo ledger gives every finding an id, forces the author to answer each one (`fix` / `reject` / `dispute` / `defer`), resumes the *same* reviewer thread every round, and stops at a hard round cap. One-way review loops were measured at 10–20 rounds; the ledger loop converges in 2–3.

## Install

```bash
claude plugin marketplace add SwiftlyAside/review-ledger
claude plugin install review-ledger@review-ledger
```

Requires Node ≥ 20 and the `codex` CLI on PATH (≥ 0.153: `exec resume`, `--json`, `--output-schema`).

## 30-second use

```bash
PLUGIN=~/.claude/plugins/cache/review-ledger/review-ledger/<version>   # or wherever Claude Code installed it
node "$PLUGIN/scripts/review-ledger.mjs" init          # once per repo → .review/config.json + rubric.md
# edit .review/rubric.md: what is P0/P1 in THIS repo
node "$PLUGIN/scripts/review-ledger.mjs" open --focus "ticket-123"
node "$PLUGIN/scripts/review-ledger.mjs" reply F1 fix --evidence "node --test → 12 passed"
node "$PLUGIN/scripts/review-ledger.mjs" reply F2 reject --reason "src/x.js:31 already validates"
node "$PLUGIN/scripts/review-ledger.mjs" round
```

In Claude Code just say "run the review loop" — the `review-ledger` skill knows the path.

## How it converges

| status | meaning |
|---|---|
| `converged` | no unresolved P0/P1 and the last round was clean |
| `escalated` | every remaining blocking finding is `disputed` → user decides |
| `capped` | `max_rounds` (3) reached → user decides |
| `stalled` | same open set, same HEAD, no transitions for two rounds → user decides |

Details: [docs/protocol.md](docs/protocol.md) · 한국어: [docs/protocol.ko.md](docs/protocol.ko.md)

## Configuration (`.review/config.json`)

| key | default | notes |
|---|---|---|
| `reviewer.model` / `effort_open` / `effort_round` / `effort_reopen` | `gpt-5.6-sol` / `xhigh` / `medium` / `high` | always pinned explicitly |
| `reviewer.probe_model` | `gpt-5.6-terra` | used only by the 30-second sandbox probe |
| `base` | `origin/main` | diff is `git diff $(git merge-base base HEAD)` |
| `blocking` | `["P0","P1"]` | only these hold the loop |
| `max_rounds` / `clean_rounds_required` / `timeout_ms` | `3` / `1` / `1200000` | |
| `transport` | `sandbox` | `sandbox`: reviewer runs git diff itself (read-only). `inline`: diff + file bodies are embedded and the reviewer is told to use no tools |
| `codex_sandbox` | `read-only` | set `danger-full-access` only if read-only exec is broken on your machine; `approval_policy=never` is then added |
| `probe` | `true` | sandbox liveness check before `open` (sandbox transport only) |
| `inline_max_bytes` | `400000` | inline payload cap; trims to diff-only, then aborts |
| `gate_tail_bytes` | `4000` | how much of each gate's output the reviewer sees |
| `exclude` | `[".review"]` | never reviewed |
| `scopes` | `{}` | `{ "docs": { "include": ["docs/**"], "exclude": [] } }` → `open --scope docs` |
| `scopes.<name>.rubric` | — | optional extra rubric file appended after `.review/rubric.md` when that scope is selected |
| `gates` | `[]` | shell commands run before every round; exit code + output tail are sent to the reviewer as evidence |

## Hooks

- **Stop**: blocks ending the turn while the ledger is `open` with unresolved blocking findings (tells you the next command). Passes when the run needs the user.
- **PostToolUse** (Edit/Write/MultiEdit): reminds you to reply when you edit a file an open finding points at.

Both are inert in repos that never ran `init`. Do not enable the codex companion plugin's own Stop review gate alongside this one — re-reviewing on every stop without a ledger is what causes infinite ping-pong.

## Development

```bash
npm test                          # unit + e2e with a fake codex (no tokens spent)
claude plugin validate --strict . # manifest check
```

MIT © 2026 Ilan Kim
