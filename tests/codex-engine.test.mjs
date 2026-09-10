import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openArgs, resumeArgs, parseThreadId, runCodex, probe } from '../scripts/lib/engines/codex.mjs'

test('openArgs pins model/effort/sandbox; danger-full-access adds approval_policy=never', () => {
  const a = openArgs({ model: 'm', effort: 'xhigh', sandbox: 'read-only', root: '/r', schema: '/s.json', outFile: '/o.json' })
  assert.deepEqual(a, ['exec', '-m', 'm', '-c', 'model_reasoning_effort="xhigh"', '-s', 'read-only', '-C', '/r', '--skip-git-repo-check', '--json', '--output-schema', '/s.json', '-o', '/o.json', '-'])
  const d = openArgs({ model: 'm', effort: 'xhigh', sandbox: 'danger-full-access', root: '/r', schema: '/s.json', outFile: '/o.json' })
  assert.ok(d.includes('approval_policy="never"'))
})
test('resumeArgs has no -m / -s', () => {
  const a = resumeArgs({ threadId: 't1', effort: 'medium', schema: '/s.json', outFile: '/o.json' })
  assert.deepEqual(a, ['exec', 'resume', 't1', '-c', 'model_reasoning_effort="medium"', '--json', '--output-schema', '/s.json', '-o', '/o.json', '-'])
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
  writeFileSync(out, '{nope')
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, spawnSync: mk({}) })
  assert.match(r.error, /not JSON/)
  writeFileSync(out, JSON.stringify(good))
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, validate: () => 'verdict', spawnSync: mk({}) })
  assert.match(r.error, /schema: verdict/)
  r = runCodex(['x'], { cwd: dir, input: 'q', outFile: out, timeout: 5, spawnSync: () => ({ error: { code: 'ETIMEDOUT' }, stdout: '' }) })
  assert.match(r.error, /timeout after 5 ms/)
})
test('probe detects ACL breakage and timeouts', () => {
  assert.equal(probe({ model: 'm', root: '/r', spawnSync: () => ({ status: 0, stdout: 'abc123 init', stderr: '' }) }).ok, true)
  assert.match(probe({ model: 'm', root: '/r', spawnSync: () => ({ status: 0, stdout: '', stderr: 'apply deny-read ACLs' }) }).error, /deny-read/)
  assert.match(probe({ model: 'm', root: '/r', spawnSync: () => ({ error: { code: 'ETIMEDOUT' } }) }).error, /timeout/)
})
