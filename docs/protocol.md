# review-ledger protocol

Korean: [protocol.ko.md](./protocol.ko.md)

## 1. Problem

One-way review (diff → findings → fixes → fresh review) was measured at 10–20 rounds. Four causes:

1. Findings have no id, so a fixed or rejected item comes back next round in different words.
2. The author has no channel to say "rejected, because…", so intentional design gets re-flagged.
3. The only exit is `approve`, so a single P3 keeps the reviewer from saying yes.
4. The reviewer thread is reopened every round and forgets its earlier judgments.

The ledger closes all four: ids, mandatory author replies, blocking-severity gate with a round cap, and one reviewer thread resumed every round.

## 2. Components

| Path | Role | git |
|---|---|---|
| `templates/rubric.core.md` (plugin) | Severity definitions, reply verdicts, output contract. Sent verbatim first every round | plugin |
| `.review/rubric.md` | Repository section: invariants (a breach is P0/P1), out-of-scope artifacts, domain notes. Sent after the core every round | committed |
| `.review/config.json` | Reviewer model/effort, base, blocking severities, round cap, transport, scopes, gates | committed |
| `.review/ledger.json` · `.review/ledger.md` | The ledger (machine · human). Written only by the CLI. `open` creates it | **gitignored** |
| `.review/runs/<run_id>/r<n>.{request.md,reply.json,events.jsonl}` | Per-round audit trail | **gitignored** |
| `scripts/review-ledger.mjs` | `init` · `open` · `reply` · `round` · `status` · `escalate` · `close` | plugin |
| `hooks/hooks.json` | Stop gate + PostToolUse reminder | plugin |

## 3. Round flow

```
RL open [--scope <name>] [--focus "…"] [--transport inline] [--base <ref>]
   → probe (sandbox transport) → gates → R1 request → reviewer, new thread
   → findings deduplicated, ids F1… assigned, thread id stored. status=open
RL reply F1 fix     --evidence "node --test → 12 passed" [--commit 9be1d0c]
RL reply F3 reject  --reason "src/x.js:31 already validates"
RL reply F4 dispute --reason "idempotency key at src/y.js:44"
RL reply F6 defer   --reason "P3, ticket-123"          # P2/P3 only
RL round [--effort medium]
   → refused while any open finding is unanswered ("the reply is the channel")
   → gates → Rn request (replies, frozen, verified, disputed, changes) → same thread resumed
   → reviewer answers EVERY reply id with accept_fix | fix_insufficient | accept_rejection | maintain | withdraw | reopen
     and reports only new findings (different anchor)
   → ledger updated, status computed
RL status | escalate [--note] | close [--note]
```

## 4. States and convergence

Finding status: `open → fixed_claimed (author fix) → fixed_verified (accept_fix) | rejected_by_author → rejected_accepted (accept_rejection) | disputed (maintain ×2) | withdrawn | deferred | closed_by_user`.

```
converged ⇔ no blocking finding is open/fixed_claimed/rejected_by_author/disputed
            ∧ clean_streak ≥ clean_rounds_required   (clean = no new blocking, no fix_insufficient, no maintain, no reopen)
escalated ⇔ every remaining blocking finding is disputed          → user decides
capped    ⇔ round ≥ max_rounds and not converged                  → user decides
stalled   ⇔ same open set, same HEAD, zero transitions, no new blocking, two rounds in a row → user decides
```

- Only `blocking` severities (default P0, P1) hold the loop. P2/P3 are recorded and replied to but never block.
- `maintain` twice on the same id freezes it as `disputed`; a third argument is not opened.
- `reopen` is accepted only on frozen or verified items and only with more than 20 characters of new evidence; anything else is discarded.
- Reviewer failure, timeout (`timeout_ms`, default 20 min) or a schema mismatch is not a round: retried once, then `escalate`. Exception: a timeout whose `--json` stream already carries `turn.completed` and whose output file passes the schema is a finished reply (codex hung at exit, not in the review) — it is accepted and logged as salvaged.
- An unanswered reply id is a protocol violation: the ledger is left untouched, the request is re-sent once with the violation named; if still unanswered the round is not counted.
- `close --note` records the user's decision; every unresolved finding becomes `closed_by_user`.

Defaults: `blocking=[P0,P1]`, `max_rounds=3`, `clean_rounds_required=1`, `timeout_ms=1200000`.

## 5. Reviewer invocation

R1 (new thread; model, effort and sandbox pinned):

```sh
codex exec -m gpt-5.6-sol -c model_reasoning_effort="xhigh" -s read-only -C "$REPO" --skip-git-repo-check \
  --json --output-schema templates/review.schema.json -o .review/runs/<run>/r1.reply.json - < .review/runs/<run>/r1.request.md
```

R2+ (same thread; `resume` inherits model and sandbox and accepts neither `-m` nor `-s`):

```sh
codex exec resume "$THREAD" -c model_reasoning_effort="medium" \
  --json --output-schema templates/review.schema.json -o .review/runs/<run>/r2.reply.json - < .review/runs/<run>/r2.request.md
```

The thread id comes from the first `--json` event, `thread.started`. Reply rounds are small (~20K input tokens), so `effort_round` is `medium`; a round containing a `reopen` uses `effort_reopen` (`high`). With `codex_sandbox: "danger-full-access"` the CLI adds `-c approval_policy="never"`.

## 6. Transports

- **sandbox** (default): the request tells the reviewer to run `git diff $(git merge-base <base> HEAD)` itself in a read-only sandbox and read any file it needs. Before R1 a 30-second probe (`reviewer.probe_model` at low effort, one shell command) checks that sandbox exec works; if it reports `deny-read ACLs` the run aborts and suggests `--transport inline`.
- **inline**: the request starts with a `<tooling>` block forbidding tool calls, then embeds the diff and the full body of every changed in-scope file. If that exceeds `inline_max_bytes`, file bodies are dropped (diff only); if the diff alone exceeds it the run aborts and asks for a narrower scope. From R2 on, only the diff since the previous round's HEAD plus the bodies of files that are new since R1 are sent; the thread remembers the R1 payload. Commit before `open` for the cleanest deltas.

## 7. Scopes and gates

- `scopes`: named `{ include, exclude }` glob sets; `open --scope <name>` restricts the reviewed files. Without a scope every file changed against the base is reviewed, minus `exclude`.
- `gates`: shell commands the CLI runs right before R1 and every round (tests, linters, budget checks). Their exit codes and output tails are appended to the request as `## Deterministic gates` so the reviewer sees machine evidence, not the author's word. A failing gate does not stop the round.

## 8. Author rules

- Close the **class**, not the instance. The reviewer gives one surface example; find the sibling paths first and mention them in the reply.
- A fix reply cites the command you ran and its result. "Fixed" is not evidence.
- A rejection or dispute cites `file:line`. A rejection the reviewer cannot trace earns a `maintain`.
- The reviewer never edits files. Implementation delegated elsewhere is re-reviewed as the author's work.
- Never tell the reviewer which engine authored the change.

## 9. Hooks

- **Stop**: if the ledger is `open` and a blocking finding is unresolved, the turn cannot end; the block reason names the next command. `capped` / `escalated` / `stalled` print a note to stderr and pass. `stop_hook_active`, a missing ledger, or any parse error passes silently.
- **PostToolUse (Edit | Write | MultiEdit)**: editing a file that an open, fixed_claimed or rejected_by_author finding points at injects a reminder to reply before the next round. It never changes the ledger.
- Both read only `<repo>/.review/ledger.json`, so the plugin is inert in repositories that never ran `init`.
- Do not enable another Stop-time re-review gate (for example the Codex companion plugin's) alongside this one: re-reviewing on every stop without a ledger is exactly what causes infinite ping-pong.
