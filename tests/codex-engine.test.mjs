import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArgs, resumeArgs, parseThreadId, runCodex, probe, findRollout, checkDrift, turnContexts } from '../scripts/lib/engines/codex.mjs'

test('openArgs pins model/effort/sandbox; danger-full-access adds approval_policy=never', () => {
  const a = openArgs({ model: 'm', effort: 'xhigh', sandbox: 'read-only', root: '/r', schema: '/s.json', outFile: '/o.json' })
  assert.deepEqual(a, ['exec', '-m', 'm', '-c', 'model_reasoning_effort="xhigh"', '-s', 'read-only', '-C', '/r', '--skip-git-repo-check', '--json', '--output-schema', '/s.json', '-o', '/o.json', '-'])
  const d = openArgs({ model: 'm', effort: 'xhigh', sandbox: 'danger-full-access', root: '/r', schema: '/s.json', outFile: '/o.json' })
  assert.ok(d.includes('approval_policy="never"'))
})
test('resumeArgs pins model, effort and sandbox (resume does not inherit them from the thread)', () => {
  const a = resumeArgs({ threadId: 't1', model: 'm', effort: 'medium', sandbox: 'read-only', schema: '/s.json', outFile: '/o.json' })
  assert.deepEqual(a, ['exec', 'resume', 't1', '-m', 'm', '-c', 'model_reasoning_effort="medium"', '-c', 'sandbox_mode="read-only"', '--json', '--output-schema', '/s.json', '-o', '/o.json', '-'])
  assert.ok(resumeArgs({ threadId: 't1', model: 'm', effort: 'medium', sandbox: 'danger-full-access', schema: '/s', outFile: '/o' }).includes('approval_policy="never"'))
  assert.throws(() => resumeArgs({ threadId: 't1', effort: 'medium', sandbox: 'read-only', schema: '/s', outFile: '/o' }), /needs model and sandbox/)
  assert.throws(() => resumeArgs({ threadId: 't1', model: 'm', effort: 'medium', schema: '/s', outFile: '/o' }), /needs model and sandbox/)
})
test('findRollout / checkDrift: newest rollout, fresh turn required, missing fields unverified', () => {
  const home = mkdtempSync(join(tmpdir(), 'rl-home-'))
  const put = (ym, day, name, lines) => { const d = join(home, 'sessions', ...ym.split('/'), day); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), lines.map((x) => JSON.stringify(x)).join('\n') + '\n') }
  const tc = (model, effort, sandbox) => ({ type: 'turn_context', payload: { model, effort, sandbox_policy: sandbox && { type: sandbox } } })
  const pin = { model: 'sol', effort: 'medium', sandbox: 'read-only' }
  assert.match(checkDrift('T', pin, { home }).unverified, /no codex rollout/)
  put('2026/09', '30', 'rollout-2026-09-30T01-00-00-T.jsonl', [{ type: 'session_meta', payload: {} }, tc('sol', 'xhigh', 'read-only'), { type: 'event_msg', payload: { type: 'turn_context_like' } }, tc('astra', 'medium', 'workspace-write')])
  put('2026/09', '29', 'rollout-2026-09-29T01-00-00-other.jsonl', [tc('sol', 'medium', 'read-only')])
  assert.match(findRollout('T', home), /rollout-2026-09-30T01-00-00-T\.jsonl$/)
  assert.equal(findRollout('missing', home), null)
  assert.equal(checkDrift('T', pin, { home }).drift, 'model astra (pinned sol), sandbox workspace-write (pinned read-only)')
  // the call must have added a turn_context: count 2 before the call and still 2 after = an older turn, not this one
  assert.match(checkDrift('T', pin, { before: 2, home }).unverified, /no new turn_context/)
  // across a year boundary and with two files for the thread on the newest day, the latest name wins
  put('2027/01', '01', 'rollout-2027-01-01T00-00-00-T.jsonl', [tc('astra', 'medium', 'read-only')])
  put('2027/01', '01', 'rollout-2027-01-01T09-00-00-T.jsonl', [tc('sol', 'medium', 'read-only')])
  assert.match(findRollout('T', home), /rollout-2027-01-01T09-00-00-T\.jsonl$/)
  assert.equal(checkDrift('T', pin, { home }).drift, null)
  assert.deepEqual(turnContexts('T', home).contexts, [{ model: 'sol', effort: 'medium', sandbox: 'read-only' }])
  // a missing field is not a match: unverified, never verified
  put('2027/01', '01', 'rollout-2027-01-01T09-00-00-T.jsonl', [tc('sol', null, 'read-only')])
  assert.match(checkDrift('T', pin, { home }).unverified, /lacks effort/)
  put('2027/01', '01', 'rollout-2027-01-01T09-00-00-T.jsonl', [tc('sol', 'medium', null)])
  assert.match(checkDrift('T', pin, { home }).unverified, /lacks sandbox/)
})
test('parseThreadId reads thread.started', () => {
  assert.equal(parseThreadId('junk\n{"type":"thread.started","thread_id":"abc"}\n{"type":"x"}'), 'abc')
  assert.equal(parseThreadId(''), null)
})
test('runCodex: success, non-zero exit, missing output, bad JSON, schema failure, timeout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rl-cx-')); const out = join(dir, 'o.json'); const ev = join(dir, 'e.jsonl')
  const mk = (r, side) => () => { side?.(); return { stdout: '{"type":"thread.started","thread_id":"T"}\n', stderr: '', status: 0, ...r } }
  const good = { verdict: 'approve', summary: '', findings: [], replies: [] }
  let r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, eventsFile: ev, timeout: 5, validate: () => null, spawnSync: mk({}, () => writeFileSync(out, JSON.stringify(good))) })
  assert.equal(r.ok, true); assert.equal(r.threadId, 'T'); assert.deepEqual(r.output, good)
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, spawnSync: mk({ status: 2, stderr: 'boom\nERROR rmcp noise' }) })
  assert.match(r.error, /codex exit 2: boom/); assert.ok(!r.error.includes('rmcp'))
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: join(dir, 'none.json'), timeout: 5, spawnSync: mk({}) })
  assert.match(r.error, /no output file/)
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, spawnSync: mk({}, () => writeFileSync(out, '{nope')) })
  assert.match(r.error, /not JSON/)
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, validate: () => 'verdict', spawnSync: mk({}, () => writeFileSync(out, JSON.stringify(good))) })
  assert.match(r.error, /schema: verdict/)
  // a reply file left by an earlier attempt is removed before the call: a call that writes nothing fails
  writeFileSync(out, JSON.stringify(good))
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, validate: () => null, spawnSync: mk({}) })
  assert.equal(r.ok, false); assert.match(r.error, /no output file/)
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, spawnSync: () => ({ error: { code: 'ETIMEDOUT' }, stdout: '' }) })
  assert.match(r.error, /timeout after 5 ms/)
  // timeout AFTER the turn completed with a valid output file = the process hung at exit; the reply is salvaged
  const done = '{"type":"thread.started","thread_id":"t9"}\n{"type":"turn.completed","usage":{}}\n'
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, validate: () => null, spawnSync: () => { writeFileSync(out, JSON.stringify(good)); return { error: { code: 'ETIMEDOUT' }, stdout: done } } })
  assert.equal(r.ok, true); assert.equal(r.salvaged, true); assert.equal(r.threadId, 't9')
  // turn.completed but the output file is missing or invalid: still a failure
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: join(dir, 'none.json'), timeout: 5, spawnSync: () => ({ error: { code: 'ETIMEDOUT' }, stdout: done }) })
  assert.equal(r.ok, false); assert.match(r.error, /no output file/)
})
test('probe detects ACL breakage and timeouts', () => {
  assert.equal(probe({ model: 'm', root: '/r', spawnSync: () => ({ status: 0, stdout: 'abc123 init', stderr: '' }) }).ok, true)
  assert.match(probe({ model: 'm', root: '/r', spawnSync: () => ({ status: 0, stdout: '', stderr: 'apply deny-read ACLs' }) }).error, /deny-read/)
  assert.match(probe({ model: 'm', root: '/r', spawnSync: () => ({ error: { code: 'ETIMEDOUT' } }) }).error, /timeout/)
})
