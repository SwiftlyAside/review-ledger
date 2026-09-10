import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STOP = fileURLToPath(new URL('../scripts/hooks/review-stop-gate.mjs', import.meta.url))
const TOUCH = fileURLToPath(new URL('../scripts/hooks/ledger-touch.mjs', import.meta.url))
const run = (script, root, input) => { const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } }); return { code: r.status, out: r.stdout, err: r.stderr } }
const withLedger = (l) => { const root = mkdtempSync(join(tmpdir(), 'rl-hook-')); if (l) { mkdirSync(join(root, '.review')); writeFileSync(join(root, '.review', 'ledger.json'), JSON.stringify(l)) } return root }
const base = { run_id: 'r', round: 1, config: { blocking: ['P0', 'P1'], max_rounds: 3 }, findings: [] }

test('stop gate: no ledger / stop_hook_active / converged → silent pass', () => {
  assert.equal(run(STOP, withLedger(null), {}).out, '')
  assert.equal(run(STOP, withLedger({ ...base, status: 'open', findings: [{ id: 'F1', severity: 'P1', status: 'open' }] }), { stop_hook_active: true }).out, '')
  assert.equal(run(STOP, withLedger({ ...base, status: 'converged' }), {}).out, '')
})
test('stop gate: open with blocking → block with next command; capped → stderr note, pass', () => {
  const r = run(STOP, withLedger({ ...base, status: 'open', findings: [{ id: 'F1', severity: 'P1', status: 'open' }, { id: 'F2', severity: 'P3', status: 'open' }] }), {})
  assert.equal(r.code, 0)
  const j = JSON.parse(r.out); assert.equal(j.decision, 'block'); assert.match(j.reason, /F1\(P1:open\)/); assert.match(j.reason, /reply F1/); assert.ok(!j.reason.includes('F2('))
  const c = run(STOP, withLedger({ ...base, status: 'capped', findings: [{ id: 'F1', severity: 'P1', status: 'open' }] }), {})
  assert.equal(c.out, ''); assert.match(c.err, /capped/)
  assert.equal(run(STOP, withLedger({ ...base, status: 'open', findings: [{ id: 'F1', severity: 'P1', status: 'fixed_verified' }] }), {}).out, '')
})
test('ledger-touch: editing a file with an open finding → additionalContext; otherwise silent', () => {
  const root = withLedger({ ...base, status: 'open', findings: [{ id: 'F1', severity: 'P1', status: 'open', file: 'src/a.js' }] })
  const hit = run(TOUCH, root, { tool_input: { file_path: join(root, 'src', 'a.js') } })
  const j = JSON.parse(hit.out); assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse'); assert.match(j.hookSpecificOutput.additionalContext, /F1\(open\)/)
  assert.equal(run(TOUCH, root, { tool_input: { file_path: join(root, 'src', 'other.js') } }).out, '')
  assert.equal(run(TOUCH, root, {}).out, '')
})
