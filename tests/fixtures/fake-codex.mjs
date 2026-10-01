#!/usr/bin/env node
// Fake codex for tests. Invoked as: node fake-codex.mjs <codex args…>
// FAKE_CODEX_SCENARIO = JSON file: [{ reply: {...} } | { fail: "msg" }, …] consumed in order (counter in FAKE_CODEX_STATE).
// Calls without -o (the probe) print "ok" and exit 0 (or fail with an ACL message when FAKE_CODEX_PROBE_FAIL is set).
// Each reviewer call records its stdin next to the -o file as <out>.request.txt.
// Each reviewer call appends a turn_context to $CODEX_HOME/sessions/2026/10/01/rollout-…-<thread>.jsonl like real codex:
// model = -m (else the "machine default" fake-default-model), sandbox = -s or -c sandbox_mode (else workspace-write);
// a step's { turn_context: {...} } overrides fields to simulate drift; { no_rollout: true } skips the write.
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const stdin = readFileSync(0, 'utf8')
const oIdx = args.indexOf('-o')
if (oIdx < 0) {
  if (process.env.FAKE_CODEX_PROBE_FAIL) { process.stderr.write('apply deny-read ACLs\n'); process.exit(1) }
  process.stdout.write('ok\n'); process.exit(0)
}
const scen = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'))
const stateFile = process.env.FAKE_CODEX_STATE
const n = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) : 0
writeFileSync(stateFile, String(n + 1))
const step = scen[n]
if (!step) { process.stderr.write('fake-codex: scenario exhausted\n'); process.exit(3) }
writeFileSync(args[oIdx + 1] + '.request.txt', stdin)
if (step.fail) { process.stderr.write(step.fail + '\n'); process.exit(2) }
const threadId = step.thread_id || (args[1] === 'resume' ? args[2] : 't-fake')
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n')
if (process.env.CODEX_HOME && !step.no_rollout) {
  const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
  const conf = (k) => args.filter((a, i) => args[i - 1] === '-c' && a.startsWith(k + '=')).map((a) => a.slice(k.length + 1).replace(/^"|"$/g, '')).pop()
  const payload = { model: flag('-m') || 'fake-default-model', effort: conf('model_reasoning_effort') || null, sandbox_policy: { type: flag('-s') || conf('sandbox_mode') || 'workspace-write' }, ...step.turn_context }
  const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '10', '01')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `rollout-2026-10-01T00-00-00-${threadId}.jsonl`), JSON.stringify({ type: 'turn_context', payload }) + '\n')
}
writeFileSync(args[oIdx + 1], JSON.stringify(step.reply))
