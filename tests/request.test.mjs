import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenRequest, buildRoundRequest, protocolViolationSuffix, TOOLING_BLOCK } from '../scripts/lib/request.mjs'

const base = { rubricCore: '# core', rubricRepo: '# repo', base: 'main', mergeBase: 'abcdef0123', root: '/r', diffCommand: 'git diff X', gates: [], focus: 'ticket-1' }
const payload = { diff: '+++ x', files: [{ path: 'a.md', content: 'hello', binary: false }, { path: 'b.png', content: null, binary: true }], mode: 'full', bytes: 10 }
const f = (o) => ({ id: 'F1', severity: 'P1', file: 'a.md', line_start: 1, line_end: 2, anchor: 'hello', title: 'T', body: 'B', status: 'fixed_claimed', author: { action: 'fix', evidence: 'ran tests', reason: '', commit: 'c1' }, reviewer: null, ...o })

test('open/sandbox: rubric core then repo, target with diff command, no tooling block', () => {
  const r = buildOpenRequest({ ...base, transport: 'sandbox', payload: null })
  assert.ok(r.startsWith('# core\n\n# repo'))
  assert.match(r, /Run `git diff X` yourself/); assert.match(r, /Author focus: ticket-1/); assert.match(r, /leave `replies` empty/)
  assert.ok(!r.includes('<tooling>'))
})

test('open/inline: tooling block first, diff + file bodies, binary omitted', () => {
  const r = buildOpenRequest({ ...base, transport: 'inline', payload })
  assert.ok(r.startsWith(TOOLING_BLOCK))
  assert.match(r, /```diff\n\+\+\+ x\n```/); assert.match(r, /## File: a\.md\n```\nhello\n```/); assert.match(r, /## File: b\.png\n\(binary — omitted\)/)
  const d = buildOpenRequest({ ...base, transport: 'inline', payload: { ...payload, mode: 'diff-only' } })
  assert.match(d, /file bodies omitted/); assert.ok(!d.includes('## File: a.md'))
})

test('round: replies block, frozen, verified, disputed, delta (inline) or re-run (sandbox)', () => {
  const ledger = { round: 1, findings: [f({}), f({ id: 'F2', status: 'rejected_by_author', author: { action: 'reject', reason: 'a.md:3 says so' }, reviewer: { verdict: 'maintain', reason: 'still' } }), f({ id: 'F3', status: 'withdrawn' }), f({ id: 'F4', status: 'fixed_verified' }), f({ id: 'F5', status: 'disputed' })] }
  const s = buildRoundRequest({ ...base, transport: 'sandbox', ledger, delta: null })
  assert.match(s, /## Round 2/); assert.match(s, /### F1 \(P1\) a\.md:1-2 — T/); assert.match(s, /AUTHOR ACTION: fix \(commit c1\)/); assert.match(s, /EVIDENCE: ran tests/)
  assert.match(s, /you already answered maintain once: still/); assert.match(s, /## Frozen[\s\S]*F3 \[withdrawn\]/); assert.match(s, /## Already verified[\s\S]*F4/); assert.match(s, /## Disputed[\s\S]*F5/)
  assert.match(s, /Re-run `git diff X`/); assert.match(s, /NEW findings only/)
  const i = buildRoundRequest({ ...base, transport: 'inline', ledger, delta: { from: 'abc1234def', diff: '+new line', newFiles: [{ path: 'n.md', content: 'n', binary: false }] } })
  assert.ok(i.startsWith(TOOLING_BLOCK)); assert.match(i, /## Changes since round 1 \(diff from abc1234\)/); assert.match(i, /\+new line/); assert.match(i, /## File: n\.md/)
})

test('protocolViolationSuffix lists ids', () => { assert.match(protocolViolationSuffix(['F1', 'F2']), /F1, F2/) })

test('open request appends scope rubric after repo rubric', () => {
  const req = buildOpenRequest({ ...base, rubricCore: 'CORE', rubricRepo: 'REPO', rubricScope: 'SCOPE-RULES', transport: 'sandbox', payload: null, scopeName: 'posts' })
  assert.ok(req.indexOf('REPO') < req.indexOf('SCOPE-RULES'))
  assert.ok(req.indexOf('SCOPE-RULES') < req.indexOf('## Target'))
})

test('round request repeats the scope rubric after the repo rubric', () => {
  const ledger = { round: 1, findings: [] }
  const req = buildRoundRequest({ ...base, rubricCore: 'CORE', rubricRepo: 'REPO', rubricScope: 'SCOPE-RULES', transport: 'sandbox', ledger, delta: null })
  assert.ok(req.indexOf('REPO') < req.indexOf('SCOPE-RULES'))
  assert.ok(req.indexOf('SCOPE-RULES') < req.indexOf('## Round 2'))
})
