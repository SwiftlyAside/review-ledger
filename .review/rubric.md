# Repository section (sent after the core rubric every round)

This repository is the review-ledger plugin itself: a Claude Code plugin (Node 20 ESM, zero dependencies) whose CLI runs an author/reviewer ledger loop with Codex as the reviewer.

## Repository invariants (a breach is P0 or P1 as marked)

1. (P0) Tests never spend tokens: `tests/` must only call the fake engine (`tests/fixtures/fake-codex.mjs`, `REVIEW_LEDGER_CODEX_BIN`/`_PREFIX`); a real `codex` invocation from a test is P0.
2. (P0) The ledger state machine and convergence rules (`scripts/lib/ledger.mjs`: statuses, `converged|escalated|capped|stalled`, unanswered-reply handling) must not change without the same change in `docs/protocol.md` and `docs/protocol.ko.md`.
3. (P1) The reviewer never edits files: engine calls stay `-s read-only` by default; `danger-full-access` only via `codex_sandbox` config. Every `codex exec` carries `-m` and `-c model_reasoning_effort=`.
4. (P1) The file set the reviewer is asked to look at must equal `changedFiles(root, merge-base, scope)` for both transports: `--scope` include/exclude and untracked files must survive `sandbox` (diff limited to in-scope tracked files + untracked list) and `inline` (payload).
5. (P1) No shell chains (`&&`, `cd`, pipes) built by the plugin itself when spawning codex — `spawnSync` with an argv array only (worktree session guards block chains). Gate commands are user-configured strings and may contain them.
6. (P1) Version fields stay in sync: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
7. (P1) README configuration table and `docs/protocol*.md` describe the shipped defaults (`templates/config.json`, `DEFAULT_CONFIG`).

## Out of scope

- `docs/superpowers/**` (specs and plans) are design context, not review targets.
- `tests/fixtures/` behaviour is test scaffolding; report only if a fixture stops representing real codex output.

## Domain notes

- `matchScope`: an exclude glob also matches when it equals the first path segment (`.review` would drop `.review/config.json`) — that is why the default exclude names `ledger.json`, `ledger.md`, `runs/**` explicitly.
- Sandbox transport: the request tells the reviewer to run a `git diff … -- <files>` limited to in-scope tracked files and lists untracked in-scope files; the set is recomputed every round.
- `codex exec resume` accepts neither `-m` nor `-s` (0.153.x) — model and sandbox are inherited from the thread.

## Allowed commands (sandbox transport only)

- Read-only: `git diff`, `git log`, `grep`, file reads, `npm test` / `node --test tests/<file>` (fake engine only, no tokens).
- Do not modify files, do not run `codex` yourself, do not touch `~/.claude` or `~/.codex`.
