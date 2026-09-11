import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepo, write } from './helpers/tmp-repo.mjs'
import { cli, scenario, ledger, calls, finding, reply } from './helpers/cli.mjs'

function repoWithChange(config = {}) {
  const { root, run } = makeRepo()
  const r = cli(root, ['init'])
  assert.equal(r.code, 0, r.out)
  writeFileSync(join(root, '.review', 'config.json'), JSON.stringify({ base: 'main', probe: false, ...config }))
  run(['add', '-A']); run(['commit', '-q', '-m', 'review-ledger init'])
  run(['checkout', '-q', '-b', 'feat'])
  write(root, 'src/a.js', 'const a = 2\n'); write(root, 'src/b.js', 'const b = 2\n')
  run(['add', '-A']); run(['commit', '-q', '-m', 'change'])
  return { root, run }
}

test('init writes config, rubric, gitignore; refuses to overwrite without --force', () => {
  const { root } = makeRepo()
  assert.equal(cli(root, ['init']).code, 0)
  assert.ok(existsSync(join(root, '.review', 'config.json'))); assert.ok(existsSync(join(root, '.review', 'rubric.md')))
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.review\/ledger\.json\n\.review\/ledger\.md\n\.review\/runs\//)
  assert.equal(cli(root, ['init']).code, 1)
  assert.equal(cli(root, ['init', '--force']).code, 0)
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').split('.review/runs/').length, 2)
})

test('(a) fix → accept_fix → converged in 2 rounds; gates output reaches the reviewer', () => {
  const { root } = repoWithChange({ transport: 'sandbox', gates: [`node -e "console.log('gate-ok')"`] })
  scenario(root, [reply([finding(), finding({ file: 'src/b.js', anchor: 'const b = 2', title: 'Other bug' })]), reply([], [{ id: 'F1', verdict: 'accept_fix', reason: 'ok' }, { id: 'F2', verdict: 'accept_fix', reason: 'ok' }], 'approve')])
  let r = cli(root, ['open', '--focus', 'ticket'])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /findings=2 \(blocking 2\)/)
  const l1 = ledger(root)
  assert.equal(l1.status, 'open'); assert.equal(l1.reviewer.thread_id, 't-fake'); assert.deepEqual(l1.files, ['src/a.js', 'src/b.js'])
  const req1 = readFileSync(join(root, '.review', 'runs', l1.run_id, 'r1.reply.json.request.txt'), 'utf8')
  assert.match(req1, /gate-ok/); assert.match(req1, /Run `git diff/); assert.match(req1, /Author focus: ticket/)
  assert.equal(cli(root, ['round']).code, 1) // unanswered F1, F2
  assert.equal(cli(root, ['reply', 'F1', 'fix']).code, 1) // fix needs evidence
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'node --test → pass']).code, 0)
  assert.equal(cli(root, ['reply', 'F2', 'fix', '--commit', 'abc1234']).code, 0)
  r = cli(root, ['round']); assert.equal(r.code, 0, r.out)
  assert.equal(ledger(root).status, 'converged'); assert.equal(ledger(root).round, 2)
  assert.match(readFileSync(join(root, '.review', 'ledger.md'), 'utf8'), /status: \*\*converged\*\*/)
  scenario(root, [reply([finding()])])
  assert.equal(cli(root, ['open']).code, 0) // a converged run can be followed by a new run
})

test('(b) reject → maintain ×2 → disputed → escalated; reject requires file:line', () => {
  const { root } = repoWithChange()
  scenario(root, [reply([finding()]), reply([], [{ id: 'F1', verdict: 'maintain', reason: 'still' }]), reply([], [{ id: 'F1', verdict: 'maintain', reason: 'still' }])])
  assert.equal(cli(root, ['open']).code, 0)
  assert.equal(cli(root, ['reply', 'F1', 'reject', '--reason', 'just no']).code, 1)
  assert.equal(cli(root, ['reply', 'F1', 'reject', '--reason', 'src/a.js:1 is intentional']).code, 0)
  assert.equal(cli(root, ['round']).code, 0); assert.equal(ledger(root).status, 'open'); assert.equal(ledger(root).findings[0].status, 'open')
  assert.equal(cli(root, ['reply', 'F1', 'dispute', '--reason', 'src/a.js:1 see design']).code, 0)
  assert.equal(cli(root, ['round']).code, 0)
  assert.equal(ledger(root).status, 'escalated'); assert.equal(ledger(root).findings[0].status, 'disputed')
  assert.equal(cli(root, ['close', '--note', 'user sided with author']).code, 0)
  assert.equal(ledger(root).status, 'closed'); assert.equal(ledger(root).findings[0].status, 'closed_by_user')
})

test('(c) fix_insufficient twice → capped at max_rounds=3; defer refused for blocking', () => {
  const { root } = repoWithChange()
  scenario(root, [reply([finding()]), reply([], [{ id: 'F1', verdict: 'fix_insufficient', reason: 'no' }]), reply([], [{ id: 'F1', verdict: 'fix_insufficient', reason: 'no' }])])
  assert.equal(cli(root, ['open']).code, 0)
  assert.equal(cli(root, ['reply', 'F1', 'defer', '--reason', 'later']).code, 1)
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'e']).code, 0); assert.equal(cli(root, ['round']).code, 0)
  assert.equal(ledger(root).status, 'open')
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'e2']).code, 0); assert.equal(cli(root, ['round']).code, 0)
  assert.equal(ledger(root).status, 'capped'); assert.equal(ledger(root).round, 3)
  assert.equal(cli(root, ['open']).code, 1) // capped run blocks a new open until closed
})

test('(d) unanswered reply → re-request once with protocol violation; still unanswered → round not counted', () => {
  const { root } = repoWithChange()
  scenario(root, [reply([finding()]), reply([], []), reply([], [])])
  assert.equal(cli(root, ['open']).code, 0)
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'e']).code, 0)
  const r = cli(root, ['round'])
  assert.equal(r.code, 1); assert.match(r.out, /did not answer F1/)
  assert.equal(calls(root), 3)
  const l = ledger(root); assert.equal(l.round, 1); assert.equal(l.findings[0].status, 'fixed_claimed')
  assert.match(readFileSync(join(root, '.review', 'runs', l.run_id, 'r2.reply.json.request.txt'), 'utf8'), /## Protocol violation/)
})

test('(e) inline transport: payload inlined with tooling block; over cap aborts before calling codex; round sends delta', () => {
  const { root } = repoWithChange({ transport: 'inline', inline_max_bytes: 10 })
  scenario(root, [reply([finding()])])
  let r = cli(root, ['open']); assert.equal(r.code, 1); assert.match(r.out, /inline_max_bytes/); assert.equal(calls(root), 0)
  writeFileSync(join(root, '.review', 'config.json'), JSON.stringify({ base: 'main', probe: false, transport: 'inline' }))
  scenario(root, [reply([finding()]), reply([], [{ id: 'F1', verdict: 'accept_fix', reason: 'ok' }], 'approve')])
  r = cli(root, ['open']); assert.equal(r.code, 0, r.out)
  const l = ledger(root)
  const req1 = readFileSync(join(root, '.review', 'runs', l.run_id, 'r1.reply.json.request.txt'), 'utf8')
  assert.ok(req1.startsWith('<tooling>')); assert.match(req1, /## File: src\/a\.js/); assert.match(req1, /\+const a = 2/)
  write(root, 'src/a.js', 'const a = 3\n'); write(root, 'src/new.js', 'new\n')
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'e']).code, 0)
  assert.equal(cli(root, ['round']).code, 0)
  const req2 = readFileSync(join(root, '.review', 'runs', l.run_id, 'r2.reply.json.request.txt'), 'utf8')
  assert.match(req2, /## Changes since round 1/); assert.match(req2, /\+const a = 3/); assert.match(req2, /## File: src\/new\.js/); assert.ok(!req2.includes('## File: src/a.js'))
  assert.equal(ledger(root).status, 'converged')
})

test('probe failure on sandbox transport aborts with an inline hint', () => {
  const { root } = repoWithChange({ transport: 'sandbox', probe: true })
  scenario(root, [reply([finding()])])
  const r = cli(root, ['open'], { FAKE_CODEX_PROBE_FAIL: '1' })
  assert.equal(r.code, 1); assert.match(r.out, /--transport inline/); assert.equal(calls(root), 0)
})

test('open with no changes / bad scope / codex failure does not create a run', () => {
  const { root, run } = makeRepo(); cli(root, ['init'])
  writeFileSync(join(root, '.review', 'config.json'), JSON.stringify({ base: 'main', probe: false }))
  run(['add', '-A']); run(['commit', '-q', '-m', 'init'])
  assert.match(cli(root, ['open']).out, /no changes/)
  const { root: r2 } = repoWithChange()
  assert.match(cli(r2, ['open', '--scope', 'nope']).out, /unknown scope/)
  scenario(r2, [{ fail: 'boom' }])
  const r = cli(r2, ['open']); assert.equal(r.code, 1); assert.match(r.out, /R1 failed/); assert.equal(ledger(r2).status, 'idle')
})

test('scope rubric: missing file dies, present file reaches R1 and the next round', () => {
  const { root } = repoWithChange({ transport: 'sandbox', scopes: { posts: { include: ['src/**'], rubric: '.review/rubric-content.md' } } })
  let r = cli(root, ['open', '--scope', 'posts'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /scopes\.posts\.rubric not found/)

  write(root, '.review/rubric-content.md', '# SCOPE-RULES\n')
  scenario(root, [reply([finding()]), reply([], [{ id: 'F1', verdict: 'accept_fix', reason: 'ok' }], 'approve')])
  r = cli(root, ['open', '--scope', 'posts'])
  assert.equal(r.code, 0, r.out)
  const l = ledger(root)
  assert.equal(l.rubric_scope, '.review/rubric-content.md')
  assert.match(readFileSync(join(root, '.review', 'runs', l.run_id, 'r1.request.md'), 'utf8'), /SCOPE-RULES/)

  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'e']).code, 0)
  assert.equal(cli(root, ['round']).code, 0)
  assert.match(readFileSync(join(root, '.review', 'runs', l.run_id, 'r2.request.md'), 'utf8'), /SCOPE-RULES/)
})
