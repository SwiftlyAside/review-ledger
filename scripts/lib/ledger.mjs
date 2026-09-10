import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const AUTHOR_ACTIONS = new Set(['fix', 'reject', 'dispute', 'defer'])
export const REVIEWER_VERDICTS = new Set(['accept_fix', 'fix_insufficient', 'accept_rejection', 'maintain', 'withdraw', 'reopen'])
export const AWAITING_AUTHOR = new Set(['open'])
export const AWAITING_REVIEWER = new Set(['fixed_claimed', 'rejected_by_author'])
export const CLOSED = new Set(['fixed_verified', 'rejected_accepted', 'withdrawn', 'deferred', 'closed_by_user'])
export const FROZEN = new Set(['rejected_accepted', 'withdrawn', 'deferred', 'closed_by_user'])
const nowIso = () => new Date().toISOString()

export function bootstrapLedger(config) {
  const { blocking, max_rounds, clean_rounds_required, timeout_ms } = config
  return { schema: 1, status: 'idle', run_id: null, base: null, merge_base: null, reviewer: null, transport: null, scope: null, files: [], config: { blocking, max_rounds, clean_rounds_required, timeout_ms }, round: 0, clean_streak: 0, next_id: 1, findings: [], history: [] }
}
export function loadLedger(dir, config) {
  const p = join(dir, 'ledger.json')
  if (!existsSync(p)) { mkdirSync(dir, { recursive: true }); saveLedger(dir, bootstrapLedger(config)) }
  return JSON.parse(readFileSync(p, 'utf8'))
}
export function saveLedger(dir, l) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ledger.json'), JSON.stringify(l, null, 2) + '\n')
  writeFileSync(join(dir, 'ledger.md'), renderMd(l))
}
export function isBlocking(l, f) { return l.config.blocking.includes(f.severity) }
export function blockingOpen(l) { return l.findings.filter((f) => isBlocking(l, f) && !CLOSED.has(f.status)) }

export function validateReply(o) {
  if (!o || typeof o !== 'object') return 'not an object'
  if (!['approve', 'needs-attention'].includes(o.verdict)) return 'verdict'
  if (!Array.isArray(o.findings) || !Array.isArray(o.replies)) return 'findings/replies not arrays'
  for (const f of o.findings) {
    if (!['P0', 'P1', 'P2', 'P3'].includes(f.severity)) return `finding severity ${f.severity}`
    if (typeof f.file !== 'string' || typeof f.title !== 'string' || typeof f.anchor !== 'string') return 'finding fields'
  }
  for (const r of o.replies) if (!REVIEWER_VERDICTS.has(r.verdict) || typeof r.id !== 'string') return `reply ${r.id}:${r.verdict}`
  return null
}

const toks = (s) => new Set((String(s).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []))
function jaccard(a, b) {
  const A = toks(a), B = toks(b)
  if (!A.size || !B.size) return 0
  let i = 0
  for (const x of A) if (B.has(x)) i++
  return i / (A.size + B.size - i)
}
export function findDuplicate(l, f) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  return l.findings.find((e) => {
    if (e.file !== f.file) return false
    const a = norm(e.anchor), b = norm(f.anchor)
    if (a && b && (a.includes(b) || b.includes(a))) return true
    return jaccard(e.title, f.title) >= 0.6
  })
}

export function assignNewFindings(l, findings, round) {
  let added = 0, blocking = 0
  for (const f of findings) {
    if (findDuplicate(l, f)) continue // frozen/verified items re-raised as "new" are ignored; reopen goes through replies
    const id = `F${l.next_id++}`
    l.findings.push({ id, severity: f.severity, confidence: f.confidence, file: f.file, line_start: f.line_start, line_end: f.line_end, anchor: f.anchor, title: f.title, body: f.body, recommendation: f.recommendation, evidence_kind: f.evidence_kind, opened_round: round, status: 'open', author: null, reviewer: null, note: null })
    added++
    if (isBlocking(l, f)) blocking++
  }
  l._roundNew = added
  return { added, blocking }
}

/** Apply reviewer replies. Only state-compatible verdicts transition; ids left awaiting the reviewer are reported as unanswered. */
export function applyReplies(l, replies, round) {
  const stats = { insufficient: 0, maintain: 0, reopen: 0, transitions: 0, unanswered: [], ignored: [] }
  const answered = new Set()
  for (const r of replies) {
    const f = l.findings.find((x) => x.id === r.id)
    if (!f) { stats.ignored.push(`${r.id}:${r.verdict}`); continue }
    const rec = { round, verdict: r.verdict, reason: r.reason }
    let applied = false
    switch (r.verdict) {
      case 'accept_fix': if (f.status === 'fixed_claimed') { f.status = 'fixed_verified'; f.reviewer = rec; applied = true } break
      case 'fix_insufficient': if (f.status === 'fixed_claimed') { f.status = 'open'; f.reviewer = rec; f.attempts = (f.attempts || 1) + 1; stats.insufficient++; applied = true } break
      case 'accept_rejection': if (f.status === 'rejected_by_author') { f.status = 'rejected_accepted'; f.reviewer = rec; applied = true } break
      case 'maintain':
        if (f.status === 'rejected_by_author') { f.maintain_count = (f.maintain_count || 0) + 1; f.reviewer = rec; f.status = f.maintain_count >= 2 ? 'disputed' : 'open'; stats.maintain++; applied = true }
        break
      case 'withdraw': if (!CLOSED.has(f.status)) { f.status = 'withdrawn'; f.reviewer = rec; applied = true } break
      case 'reopen':
        if (['rejected_accepted', 'withdrawn', 'fixed_verified'].includes(f.status) && typeof r.reason === 'string' && r.reason.length > 20) { f.status = 'open'; f.reviewer = rec; f.reopened_round = round; stats.reopen++; applied = true }
        break
    }
    if (applied) { answered.add(r.id); stats.transitions++ } else stats.ignored.push(`${r.id}:${r.verdict}`)
  }
  for (const f of l.findings) if (AWAITING_REVIEWER.has(f.status) && !answered.has(f.id)) stats.unanswered.push(f.id)
  return stats
}

export function computeStatus(l, { newBlocking, insufficient, maintain, reopen, transitions = 0, head }) {
  const bo = blockingOpen(l)
  const clean = newBlocking === 0 && insufficient === 0 && maintain === 0 && reopen === 0
  l.clean_streak = clean ? l.clean_streak + 1 : 0
  const openIds = bo.map((f) => f.id).sort().join(',')
  const prev = l.history[l.history.length - 1]
  const stalled = !!prev && prev.open_ids === openIds && prev.head === head && bo.length > 0 && transitions === 0 && newBlocking === 0
  l.history.push({ round: l.round, at: nowIso(), new_findings: l._roundNew || 0, new_blocking: newBlocking, blocking_open: bo.length, clean, head, open_ids: openIds })
  delete l._roundNew
  if (bo.length === 0 && l.clean_streak >= l.config.clean_rounds_required) l.status = 'converged'
  else if (bo.length > 0 && bo.every((f) => f.status === 'disputed')) l.status = 'escalated'
  else if (l.round >= l.config.max_rounds) l.status = 'capped'
  else if (stalled) l.status = 'stalled'
  else l.status = 'open'
}

function lastActor(f) {
  if (f.note) return 'user'
  if (f.reviewer && (!f.author || f.reviewer.round >= f.author.round)) return `reviewer r${f.reviewer.round}`
  if (f.author) return `author r${f.author.round}`
  return `reviewer r${f.opened_round}`
}
export function renderMd(l) {
  const rows = l.findings.map((f) => `| ${f.id} | ${f.severity} | ${f.status} | ${f.file}:${f.line_start} | ${String(f.title).replace(/\|/g, '\\|')} | ${lastActor(f)} |`)
  const hist = l.history.map((h) => `| ${h.round} | ${h.new_findings} | ${h.new_blocking} | ${h.blocking_open} | ${h.clean ? 'clean' : ''} | ${(h.head || '').slice(0, 7)} |`)
  const rev = l.reviewer ? `${l.reviewer.model}@${l.reviewer.effort} (${l.reviewer.thread_id ? l.reviewer.thread_id.slice(0, 8) : 'no-thread'})` : '-'
  return [
    `# Review ledger — ${l.run_id || '(idle)'}`, '',
    `status: **${l.status}** · round ${l.round}/${l.config.max_rounds} · base \`${l.base || '-'}\` · transport ${l.transport || '-'} · reviewer ${rev} · blocking ${l.config.blocking.join('/')}`, '',
    '| id | sev | status | where | title | last |', '|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| – | | | | (no findings) | |']), '',
    '| round | new | new blocking | blocking open | clean | head |', '|---|---|---|---|---|---|',
    ...(hist.length ? hist : ['| – | | | | | |']), '',
    ...l.findings.filter((f) => ['disputed', 'closed_by_user', 'rejected_by_author'].includes(f.status)).map((f) => `- **${f.id}** ${f.title}\n  - reviewer: ${f.body}\n  - author(${f.author?.action}): ${f.author?.reason || f.author?.evidence || ''}\n  - reviewer reply: ${f.reviewer?.reason || ''}${f.note ? `\n  - user: ${f.note}` : ''}`),
    '',
  ].join('\n')
}
