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
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.review', 'config.json'), 'utf8')).exclude, ['.review/ledger.json', '.review/ledger.md', '.review/runs/**'])
})

test('sandbox transport keeps --scope and enumerates untracked in-scope files; the ledger file list is refreshed each round', () => {
  const { root, run } = repoWithChange({ transport: 'sandbox', scopes: { src: { include: ['src/**'] } } })
  write(root, 'src/c.js', 'const c = 1\n'); write(root, 'docs/x.md', 'x\n')
  scenario(root, [reply([finding()]), reply([], [{ id: 'F1', verdict: 'accept_fix', reason: 'ok' }], 'approve')])
  let r = cli(root, ['open', '--scope', 'src']); assert.equal(r.code, 0, r.out)
  const l1 = ledger(root)
  assert.deepEqual(l1.files, ['src/a.js', 'src/b.js', 'src/c.js'])
  const req1 = readFileSync(join(root, '.review', 'runs', l1.run_id, 'r1.reply.json.request.txt'), 'utf8')
  assert.match(req1, /-- ':\(top,literal\)src\/a\.js' ':\(top,literal\)src\/b\.js'`/); assert.match(req1, /Untracked in-scope files[^\n]*`src\/c\.js`/); assert.ok(!req1.includes('docs/x.md'))
  run(['add', 'src/c.js']); run(['commit', '-q', '-m', 'c']); write(root, 'src/d.js', 'const d = 1\n')
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'e']).code, 0)
  r = cli(root, ['round']); assert.equal(r.code, 0, r.out)
  const req2 = readFileSync(join(root, '.review', 'runs', l1.run_id, 'r2.reply.json.request.txt'), 'utf8')
  assert.match(req2, /Re-run `git diff[^`]*':\(top,literal\)src\/a\.js' ':\(top,literal\)src\/b\.js' ':\(top,literal\)src\/c\.js'`/); assert.match(req2, /Untracked in-scope files[^\n]*`src\/d\.js`/)
  assert.deepEqual(ledger(root).files, ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'])
})

test('(a) fix → accept_fix → converged in 2 rounds; gates output reaches the reviewer', () => {
  const { root } = repoWithChange({ transport: 'sandbox', gates: [`node -e "console.log('gate-ok')"`] })
  scenario(root, [reply([finding(), finding({ file: 'src/b.js', anchor: 'const b = 2', title: 'Other bug' })]), reply([], [{ id: 'F1', verdict: 'accept_fix', reason: 'ok' }, { id: 'F2', verdict: 'accept_fix', reason: 'ok' }], 'approve')])
  let r = cli(root, ['open', '--focus', 'ticket'])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /findings=2 \(blocking 2\)/)
  const l1 = ledger(root)
  assert.equal(l1.status, 'open'); assert.equal(l1.reviewer.thread_id, 't-fake'); assert.deepEqual(l1.files, ['src/a.js', 'src/b.js'])
  const req1 = readFileSync(join(root, '.review', 'runs', l1.run_id, 'r1.reply.json.request.txt'), 'utf8')
  assert.match(req1, /gate-ok/); assert.match(req1, /Run `git diff \$\(git merge-base main HEAD\) -- ':\(top,literal\)src\/a\.js' ':\(top,literal\)src\/b\.js'`/); assert.match(req1, /Author focus: ticket/); assert.ok(!req1.includes('Untracked in-scope'))
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

const SOL = { transport: 'sandbox', codex_sandbox: 'read-only', reviewer: { engine: 'codex', model: 'sol', effort_open: 'xhigh', effort_round: 'medium', effort_reopen: 'high', probe_model: 'p' } }
const ok1 = () => reply([], [{ id: 'F1', verdict: 'accept_fix', reason: 'ok' }], 'approve')
function openedWithFix(config = SOL, extraSteps = []) {
  const { root } = repoWithChange(config)
  scenario(root, [reply([finding()]), ...extraSteps])
  const r = cli(root, ['open'])
  assert.equal(r.code, 0, r.out)
  assert.equal(cli(root, ['reply', 'F1', 'fix', '--evidence', 'test passes']).code, 0)
  return root
}

test('(f) resume pins the R1 model and sandbox and records what each round actually ran on', () => {
  const root = openedWithFix(SOL, [ok1()])
  const l1 = ledger(root)
  assert.equal(l1.reviewer.sandbox, 'read-only')
  assert.deepEqual(l1.history[0].reviewer, { verified: true, model: 'sol', effort: 'xhigh', sandbox: 'read-only' })
  const r = cli(root, ['round'])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /R2 resume t-fake sol@medium read-only/)
  const l2 = ledger(root)
  assert.equal(l2.status, 'converged'); assert.deepEqual(l2.history[1].reviewer, { verified: true, model: 'sol', effort: 'medium', sandbox: 'read-only' })
  const req = readFileSync(join(root, '.review', 'runs', l2.run_id, 'r2.reply.json.request.txt'), 'utf8')
  assert.ok(req.length > 0)
})

test('(g) a drifted reviewer turn is discarded and escalates the run (the thread is contaminated)', () => {
  const root = openedWithFix(SOL, [{ ...ok1(), turn_context: { model: 'astra', sandbox_policy: { type: 'workspace-write' } } }, ok1()])
  let r = cli(root, ['round'])
  assert.equal(r.code, 1); assert.match(r.out, /R2 ran with model astra \(pinned sol\), sandbox workspace-write \(pinned read-only\)/)
  assert.match(r.out, /drifted turn stays in codex thread t-fake; close this run and open a new one/)
  const l = ledger(root)
  assert.equal(l.status, 'escalated'); assert.equal(l.round, 1); assert.equal(l.findings[0].status, 'fixed_claimed'); assert.equal(l.history.length, 1)
  r = cli(root, ['round'])
  assert.equal(r.code, 1); assert.match(r.out, /run is escalated/); assert.equal(calls(root), 2)
})

test('(h) unverifiable turns warn UNVERIFIED: no rollout, or no new turn_context for this call', () => {
  const { root } = repoWithChange({ transport: 'sandbox' })
  scenario(root, [{ ...reply([]), no_rollout: true }])
  let r = cli(root, ['open'])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /WARNING R1: no codex rollout for the thread — reviewer model\/effort\/sandbox UNVERIFIED/)
  assert.deepEqual(ledger(root).history[0].reviewer, { verified: false })
  const root2 = openedWithFix(SOL, [{ ...ok1(), no_rollout: true }])
  r = cli(root2, ['round'])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /WARNING R2: no new turn_context in .*UNVERIFIED/)
  assert.deepEqual(ledger(root2).history[1].reviewer, { verified: false })
})

test('(i) resume answering on another thread is a failed call, never applied', () => {
  const root = openedWithFix(SOL, [{ ...ok1(), thread_id: 'other' }, { ...ok1(), thread_id: 'other' }])
  const r = cli(root, ['round'])
  assert.equal(r.code, 1); assert.match(r.out, /resume answered on thread other, not t-fake/); assert.match(r.out, /retry failed \(not counted/)
  assert.equal(ledger(root).round, 1); assert.equal(ledger(root).status, 'open')
})

test('(j) a ≤0.2.1 ledger without reviewer.sandbox takes it from the R1 rollout, not from the current config', () => {
  const root = openedWithFix(SOL, [ok1()])
  const lp = join(root, '.review', 'ledger.json'); const l = ledger(root); delete l.reviewer.sandbox; writeFileSync(lp, JSON.stringify(l))
  const cp = join(root, '.review', 'config.json'); writeFileSync(cp, JSON.stringify({ ...JSON.parse(readFileSync(cp, 'utf8')), codex_sandbox: 'danger-full-access' }))
  const r = cli(root, ['round'])
  assert.equal(r.code, 0, r.out); assert.match(r.out, /reviewer.sandbox recovered from the R1 rollout: read-only/); assert.match(r.out, /sol@medium read-only/)
  assert.equal(ledger(root).reviewer.sandbox, 'read-only')
  // a later rollout of the same thread starting with another sandbox: R1 = the oldest file, not the newest
  const root3 = openedWithFix(SOL, [ok1()])
  const l3 = ledger(root3); delete l3.reviewer.sandbox; writeFileSync(join(root3, '.review', 'ledger.json'), JSON.stringify(l3))
  write(root3 + '.codex-home', 'sessions/2026/10/02/rollout-2026-10-02T00-00-00-t-fake.jsonl', JSON.stringify({ type: 'turn_context', payload: { model: 'sol', effort: 'medium', sandbox_policy: { type: 'workspace-write' } } }) + '\n')
  const r3 = cli(root3, ['round'])
  assert.equal(r3.code, 0, r3.out); assert.match(r3.out, /recovered from the R1 rollout: read-only/); assert.equal(ledger(root3).reviewer.sandbox, 'read-only')
  // the R1 context lacks the sandbox while a later turn has one: refuse, never adopt the later value
  const root4 = openedWithFix(SOL, [ok1()])
  const l4 = ledger(root4); delete l4.reviewer.sandbox; writeFileSync(join(root4, '.review', 'ledger.json'), JSON.stringify(l4))
  const tc = (sandbox) => JSON.stringify({ type: 'turn_context', payload: { model: 'sol', effort: 'xhigh', sandbox_policy: sandbox && { type: sandbox } } })
  write(root4 + '.codex-home', 'sessions/2026/10/01/rollout-2026-10-01T00-00-00-t-fake.jsonl', [tc(null), tc('workspace-write')].join(String.fromCharCode(10)))
  const r4 = cli(root4, ['round'])
  assert.equal(r4.code, 1); assert.match(r4.out, /does not show a known one \(none\)/); assert.equal(calls(root4), 1)
  // recovery persists only reviewer.sandbox: an inline run whose next call fails still sends a new untracked file on retry
  const { root: root5 } = repoWithChange({ ...SOL, transport: 'inline' })
  scenario(root5, [reply([finding()]), { fail: 'boom' }, { fail: 'boom' }, ok1()])
  assert.equal(cli(root5, ['open']).code, 0)
  assert.equal(cli(root5, ['reply', 'F1', 'fix', '--evidence', 'ok']).code, 0)
  const l5 = ledger(root5); delete l5.reviewer.sandbox; writeFileSync(join(root5, '.review', 'ledger.json'), JSON.stringify(l5))
  write(root5, 'src/new.js', 'const fresh = 1' + String.fromCharCode(10))
  assert.equal(cli(root5, ['round']).code, 1)
  assert.deepEqual(ledger(root5).files, ['src/a.js', 'src/b.js']); assert.equal(ledger(root5).reviewer.sandbox, 'read-only')
  assert.equal(cli(root5, ['round']).code, 0)
  assert.match(readFileSync(join(root5, '.review', 'runs', ledger(root5).run_id, 'r2.reply.json.request.txt'), 'utf8'), /const fresh = 1/)
  // no rollout to recover from: refuse rather than guess
  const root2 = openedWithFix(SOL, [ok1()])
  const l2 = ledger(root2); delete l2.reviewer.sandbox; writeFileSync(join(root2, '.review', 'ledger.json'), JSON.stringify(l2))
  const r2 = cli(root2, ['round'], { CODEX_HOME: root2 + '.empty-home' })
  assert.equal(r2.code, 1); assert.match(r2.out, /no reviewer.sandbox .* close this run and open a new one/); assert.equal(calls(root2), 1)
})

test('(k) --help / -h / help print usage and never call codex, even after a flag that takes a value', () => {
  const { root } = repoWithChange({ transport: 'sandbox' })
  scenario(root, [reply([finding()])])
  for (const args of [['open', '--help'], ['open', '--no-probe', '-h'], ['open', '--focus', '-h'], ['open', '--help=true'], ['open', '--help='], ['round', '-h'], ['help'], ['--help']]) {
    const r = cli(root, args)
    assert.equal(r.code, 0, r.out); assert.match(r.out, /usage: review-ledger <command>/)
  }
  assert.equal(calls(root), 0); assert.ok(!existsSync(join(root, '.review', 'ledger.json')))
})
