#!/usr/bin/env node
// Fake codex for tests. Invoked as: node fake-codex.mjs <codex args…>
// FAKE_CODEX_SCENARIO = JSON file: [{ reply: {...} } | { fail: "msg" }, …] consumed in order (counter in FAKE_CODEX_STATE).
// Calls without -o (the probe) print "ok" and exit 0 (or fail with an ACL message when FAKE_CODEX_PROBE_FAIL is set).
// Each reviewer call records its stdin next to the -o file as <out>.request.txt.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
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
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: step.thread_id || 't-fake' }) + '\n')
writeFileSync(args[oIdx + 1], JSON.stringify(step.reply))
