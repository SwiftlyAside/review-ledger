import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeConfig } from '../scripts/lib/config.mjs'
import { bootstrapLedger, validateReply, findDuplicate, assignNewFindings, applyReplies, computeStatus, blockingOpen, renderMd, CLOSED } from '../scripts/lib/ledger.mjs'

const cfg = mergeConfig({})
const finding = (o = {}) => ({ temp_id: 't', severity: 'P1', confidence: 0.9, file: 'src/a.js', line_start: 1, line_end: 2, anchor: 'const x = 1', title: 'Off by one in loop', body: 'b', recommendation: 'r', evidence_kind: 'inference', ...o })
const ledger = (o = {}) => ({ ...bootstrapLedger(cfg), status: 'open', run_id: 't', base: 'main', round: 1, findings: [], history: [], ...o })
const opened = (l, fs, round = 1) => { assignNewFindings(l, fs, round); return l }

test('bootstrapLedger: idle with config subset', () => {
  const l = bootstrapLedger(cfg)
  assert.equal(l.status, 'idle')
  assert.deepEqual(l.config, { blocking: ['P0', 'P1'], max_rounds: 3, clean_rounds_required: 1, timeout_ms: 1200000 })
})

test('validateReply catches schema violations', () => {
  assert.equal(validateReply({ verdict: 'approve', findings: [], replies: [] }), null)
  assert.match(validateReply({ verdict: 'yes', findings: [], replies: [] }), /verdict/)
  assert.match(validateReply({ verdict: 'approve', findings: [finding({ severity: 'high' })], replies: [] }), /severity/)
  assert.match(validateReply({ verdict: 'approve', findings: [], replies: [{ id: 'F1', verdict: 'lgtm', reason: '' }] }), /F1:lgtm/)
})

test('findDuplicate: same file + anchor containment or title Jaccard ≥ 0.6', () => {
  const l = opened(ledger(), [finding()])
  assert.ok(findDuplicate(l, finding({ anchor: 'x = 1', title: 'totally different' })))
  assert.ok(findDuplicate(l, finding({ anchor: 'zzz', title: 'Off by one loop' })))
  assert.equal(findDuplicate(l, finding({ file: 'src/b.js' })), undefined)
})

test('assignNewFindings: ids F1.., counts blocking, skips duplicates', () => {
  const l = ledger()
  const r = assignNewFindings(l, [finding(), finding({ file: 'x', severity: 'P3', anchor: 'q', title: 'Rename var' }), finding()], 1)
  assert.deepEqual(r, { added: 2, blocking: 1 })
  assert.deepEqual(l.findings.map((f) => f.id), ['F1', 'F2'])
  assert.equal(l.next_id, 3)
})

test('applyReplies: only state-compatible verdicts transition; others are ignored and left unanswered', () => {
  const l = opened(ledger(), [finding(), finding({ file: 'b', anchor: 'b', title: 'Second' })])
  l.findings[0].status = 'fixed_claimed'; l.findings[1].status = 'rejected_by_author'
  const s = applyReplies(l, [{ id: 'F1', verdict: 'accept_fix', reason: '' }, { id: 'F2', verdict: 'accept_fix', reason: '' }], 2)
  assert.equal(l.findings[0].status, 'fixed_verified')
  assert.equal(l.findings[1].status, 'rejected_by_author')
  assert.deepEqual(s.unanswered, ['F2']); assert.deepEqual(s.ignored, ['F2:accept_fix']); assert.equal(s.transitions, 1)
})

test('applyReplies: maintain ×2 → disputed; fix_insufficient reopens; reopen needs >20 chars', () => {
  const l = opened(ledger(), [finding()])
  l.findings[0].status = 'rejected_by_author'
  applyReplies(l, [{ id: 'F1', verdict: 'maintain', reason: 'still' }], 2)
  assert.equal(l.findings[0].status, 'open'); assert.equal(l.findings[0].maintain_count, 1)
  l.findings[0].status = 'rejected_by_author'
  applyReplies(l, [{ id: 'F1', verdict: 'maintain', reason: 'still' }], 3)
  assert.equal(l.findings[0].status, 'disputed')
  const m = opened(ledger(), [finding()]); m.findings[0].status = 'fixed_claimed'
  const s = applyReplies(m, [{ id: 'F1', verdict: 'fix_insufficient', reason: 'nope' }], 2)
  assert.equal(m.findings[0].status, 'open'); assert.equal(s.insufficient, 1); assert.equal(m.findings[0].attempts, 2)
  m.findings[0].status = 'fixed_verified'
  assert.equal(applyReplies(m, [{ id: 'F1', verdict: 'reopen', reason: 'short' }], 3).reopen, 0)
  assert.equal(applyReplies(m, [{ id: 'F1', verdict: 'reopen', reason: 'new evidence: the guard at a.js:9 is bypassed' }], 3).reopen, 1)
  assert.equal(m.findings[0].status, 'open')
})

test('computeStatus: converged / escalated / capped / stalled / open', () => {
  const conv = opened(ledger(), [finding()]); conv.findings[0].status = 'fixed_verified'
  computeStatus(conv, { newBlocking: 0, insufficient: 0, maintain: 0, reopen: 0, transitions: 1, head: 'a' })
  assert.equal(conv.status, 'converged')
  const esc = opened(ledger(), [finding()]); esc.findings[0].status = 'disputed'
  computeStatus(esc, { newBlocking: 0, insufficient: 0, maintain: 1, reopen: 0, transitions: 1, head: 'a' })
  assert.equal(esc.status, 'escalated')
  const cap = opened(ledger({ round: 3 }), [finding()])
  computeStatus(cap, { newBlocking: 1, insufficient: 0, maintain: 0, reopen: 0, transitions: 0, head: 'a' })
  assert.equal(cap.status, 'capped')
  const st = opened(ledger({ round: 2, history: [{ round: 1, open_ids: 'F1', head: 'a' }] }), [finding()])
  computeStatus(st, { newBlocking: 0, insufficient: 0, maintain: 0, reopen: 0, transitions: 0, head: 'a' })
  assert.equal(st.status, 'stalled')
  const op = opened(ledger({ round: 2, history: [{ round: 1, open_ids: 'F1', head: 'a' }] }), [finding()])
  computeStatus(op, { newBlocking: 0, insufficient: 0, maintain: 1, reopen: 0, transitions: 1, head: 'a' })
  assert.equal(op.status, 'open')
  assert.equal(blockingOpen(op).length, 1)
  assert.ok(CLOSED.has('deferred'))
})

test('renderMd includes status line, findings table, history table', () => {
  const l = opened(ledger(), [finding()])
  computeStatus(l, { newBlocking: 1, insufficient: 0, maintain: 0, reopen: 0, transitions: 0, head: 'abcdef0' })
  const md = renderMd(l)
  assert.match(md, /status: \*\*open\*\* · round 1\/3/)
  assert.match(md, /\| F1 \| P1 \| open \| src\/a\.js:1 \|/)
  assert.match(md, /\| 1 \| 1 \| 1 \| 1 \|  \| abcdef0 \|/)
})
