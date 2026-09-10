---
name: review-loop
description: Run a ledger-backed, bidirectional author↔reviewer review loop (you author, Codex reviews) with finding ids, mandatory replies, same-thread resume, and a 3-round cap. Triggers — "review loop", "리뷰 루프", "adversarial review", "적대 리뷰", "codex review", "sol 리뷰", "/review-loop", and right before declaring a multi-file change done. Use this instead of one-shot review commands, which reopen a fresh thread each time and have no finding ids (10–20 rounds observed).
---

# review-loop

CLI: `node "<this skill's directory>/../../scripts/review-loop.mjs" <command>` — call it `RL` below. Protocol reference: `docs/protocol.md` in the plugin root. Do not paraphrase the rules from memory; the ledger and the CLI enforce them.

1. **First time in a repo:** `RL init`, then edit `.review/rubric.md` (repository invariants = what counts as P0/P1 here) and `.review/config.json` (`base`, `transport`, `scopes`, `gates`). Commit both. Ledger and runs are gitignored.
2. **Open:** commit or at least save the change, then `RL open --focus "<ticket / what to look at>"` (add `--scope <name>` to limit files, `--transport inline` if the reviewer sandbox cannot read files). Read the printed table.
3. **Reply to every `open` finding — exactly one action each.** Close the *class*, not the instance: the reviewer gives one surface example; find the sibling paths yourself first.
   - Fixed: `RL reply F1 fix --evidence "<command you ran → result>" [--commit <sha>]`
   - Wrong finding: `RL reply F2 reject --reason "<file:line why>"`
   - Disagreement worth a trace: `RL reply F3 dispute --reason "<file:line why>"`
   - Non-blocking, later: `RL reply F4 defer --reason "<ticket>"` (P2/P3 only)
4. **Round:** `RL round`. The same reviewer thread answers every reply with a verdict and reports only new findings. If status is `open`, go to 3.
5. **Finish:** `converged` → attach `run_id` and `.review/ledger.md` to your report/PR. `capped` / `escalated` / `stalled` → show `.review/ledger.md` to the user, get their decision, then `RL close --note "<decision>"`.

Rules: never let the reviewer edit files; never tell the reviewer which engine authored the change; "fixed" is not evidence — the command and its result are. The Stop hook blocks ending the turn while blocking findings are unresolved.
