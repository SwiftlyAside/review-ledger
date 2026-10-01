#!/usr/bin/env node
// review-ledger — ledger-backed author ↔ reviewer loop. Author = the agent running this CLI; reviewer = codex exec (same thread resumed each round).
//   review-ledger init [--force]
//   review-ledger open  [--scope <name>] [--focus "…"] [--transport sandbox|inline] [--base <ref>] [--no-probe] [--model m] [--effort e]
//   review-ledger reply <id> <fix|reject|dispute|defer> [--reason "…"] [--evidence "…"] [--commit sha]
//   review-ledger round [--effort e]
//   review-ledger status | escalate [--note "…"] | close [--note "…"]
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_ROOT, TEMPLATES, CLI, resolveRoot, reviewDir } from './lib/paths.mjs'
import { loadConfig, EFFORTS, TRANSPORTS, SANDBOXES } from './lib/config.mjs'
import { loadLedger, saveLedger, bootstrapLedger, validateReply, assignNewFindings, applyReplies, computeStatus, blockingOpen, isBlocking, renderMd, AUTHOR_ACTIONS, AWAITING_AUTHOR, CLOSED } from './lib/ledger.mjs'
import { resolveScope, mergeBase, head, changedFiles, untrackedFiles, collectInline, diffText, readEntry, sandboxTarget, git } from './lib/payload.mjs'
import { runGates } from './lib/gates.mjs'
import { buildOpenRequest, buildRoundRequest, protocolViolationSuffix } from './lib/request.mjs'
import { openArgs, resumeArgs, runCodex, probe, checkDrift, turnContexts, firstSandbox } from './lib/engines/codex.mjs'

const USAGE = `usage: review-ledger <command>
  init [--force]
  open  [--scope <name>] [--focus "…"] [--transport sandbox|inline] [--base <ref>] [--no-probe] [--model m] [--effort e]
  reply <id> <fix|reject|dispute|defer> [--reason "…"] [--evidence "…"] [--commit sha]
  round [--effort e]
  status | escalate [--note "…"] | close [--note "…"]`
const ROOT = resolveRoot()
const REVIEW = reviewDir(ROOT)
const RUBRIC_REPO = join(REVIEW, 'rubric.md')
const HINT = `node "${CLI}"`

function parseArgs(argv) {
  const opts = {}, pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) opts[a.slice(2, eq)] = a.slice(eq + 1)
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[a.slice(2)] = argv[++i]
      else opts[a.slice(2)] = true
    } else pos.push(a)
  }
  return { opts, pos }
}
const die = (msg) => { console.error(`[review-ledger] ${msg}`); process.exit(1) }
const readScopeRubric = (rel, name) => {
  if (!rel) return ''
  const p = join(ROOT, rel)
  if (!existsSync(p)) die(`scopes.${name}.rubric not found: ${p}`)
  return readFileSync(p, 'utf8')
}
const log = (msg) => console.log(`[review-ledger] ${msg}`)
const nowIso = () => new Date().toISOString()
const runId = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
function rubrics() {
  if (!existsSync(RUBRIC_REPO)) die(`.review/rubric.md not found — run: ${HINT} init`)
  return { rubricCore: readFileSync(TEMPLATES.rubricCore, 'utf8'), rubricRepo: readFileSync(RUBRIC_REPO, 'utf8') }
}
function printStatus(l) {
  console.log(renderMd(l))
  const bo = blockingOpen(l)
  console.log(`→ status=${l.status}; blocking open=${bo.length}${bo.length ? ' (' + bo.map((f) => `${f.id}:${f.status}`).join(', ') + ')' : ''}; awaiting author=${l.findings.filter((f) => AWAITING_AUTHOR.has(f.status)).map((f) => f.id).join(',') || '-'}`)
}
function nextHint(l) {
  if (l.status === 'open') return `\nNext: reply to every open finding (${HINT} reply <id> <fix|reject|dispute|defer> …), then ${HINT} round`
  if (l.status === 'converged') return '\nConverged. Attach run_id and .review/ledger.md to your report.'
  return `\n${l.status} — show .review/ledger.md to the user and record their decision with ${HINT} close --note "…"`
}
/**
 * Compare the turn just run (turn_context count must exceed `before`) with the pinned model/effort/sandbox.
 * Unverifiable = loud warning + verified:false. Drift = onDrift(message), which must not return.
 */
function verifyReviewer(label, threadId, pinned, before, onDrift) {
  const r = checkDrift(threadId, pinned, { before })
  if (r.unverified) { console.error(`[review-ledger] WARNING ${label}: ${r.unverified} — reviewer model/effort/sandbox UNVERIFIED (pinned ${pinned.model}@${pinned.effort} ${pinned.sandbox})`); return { verified: false } }
  if (r.drift) onDrift(`${label} ran with ${r.drift} (rollout ${r.observed.file})`)
  return { verified: true, model: r.observed.model, effort: r.observed.effort, sandbox: r.observed.sandbox }
}
/** Inline transport, round ≥ 2: diff since the previous round's head plus full bodies of files that are new since round 1. */
function inlineDelta(l) {
  const from = l.history[l.history.length - 1]?.head || l.merge_base
  const files = [...new Set([...l.files, ...changedFiles(ROOT, l.merge_base, l.scope_globs)])].sort()
  const untracked = untrackedFiles(ROOT)
  const newFiles = files.filter((p) => untracked.has(p) && !l.files.includes(p)).map((p) => readEntry(ROOT, p)).filter(Boolean)
  l.files = files
  return { from, diff: diffText(ROOT, from, files.filter((p) => !untracked.has(p))), newFiles }
}

/** { diffCommand, untracked } for the request builders; empty for inline. */
function sandboxTargetFor(transport, base, files) {
  if (transport !== 'sandbox') return {}
  const t = sandboxTarget(ROOT, base, files)
  return { diffCommand: t.diffCommand, untracked: t.untracked }
}

// ── commands ─────────────────────────────────────────────────────────────────
function cmdInit(opts) {
  mkdirSync(REVIEW, { recursive: true })
  const cfg = join(REVIEW, 'config.json')
  if ((existsSync(cfg) || existsSync(RUBRIC_REPO)) && !opts.force) die('.review/config.json or rubric.md already exists — use --force to overwrite')
  copyFileSync(TEMPLATES.config, cfg)
  copyFileSync(TEMPLATES.rubricRepo, RUBRIC_REPO)
  const gi = join(ROOT, '.gitignore')
  const lines = ['.review/ledger.json', '.review/ledger.md', '.review/runs/']
  const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : ''
  const missing = lines.filter((x) => !cur.split(/\r?\n/).includes(x))
  if (missing.length) appendFileSync(gi, (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n')
  log(`initialized ${REVIEW}`)
  console.log(`Edit .review/rubric.md (repository invariants) and .review/config.json (base, transport, scopes, gates).\nCLI: ${HINT} <open|reply|round|status|escalate|close>`)
}

function cmdOpen(opts) {
  const cfg = loadConfig(ROOT)
  const l = loadLedger(REVIEW, cfg)
  if (['open', 'capped', 'escalated', 'stalled'].includes(l.status)) die(`run ${l.run_id} is ${l.status} — close it (${HINT} close --note "…") or check status`)
  const { rubricCore, rubricRepo } = rubrics()
  const model = opts.model || cfg.reviewer.model
  const effort = opts.effort || cfg.reviewer.effort_open
  if (!EFFORTS.has(effort)) die(`effort ${effort} is not allowed`)
  const transport = opts.transport || cfg.transport
  if (!TRANSPORTS.has(transport)) die(`transport ${transport} is not allowed (sandbox|inline)`)
  const base = opts.base || cfg.base
  if (!git(ROOT, ['rev-parse', '--verify', base])) die(`base ${base} not found (if it is origin/main, run git fetch origin main first)`)
  const mb = mergeBase(ROOT, base)
  if (!mb) die(`no merge-base between ${base} and HEAD`)
  let scope
  try { scope = resolveScope(cfg, opts.scope || null) } catch (e) { die(e.message) }
  const rubricScope = readScopeRubric(opts.scope ? cfg.scopes[opts.scope]?.rubric : null, opts.scope)
  const files = changedFiles(ROOT, mb, scope)
  if (!files.length) die(`no changes against ${base} (merge-base ${mb.slice(0, 7)})${opts.scope ? ` in scope ${opts.scope}` : ''} — nothing to review`)
  if (transport === 'sandbox' && cfg.probe && !opts['no-probe']) {
    log(`probing codex sandbox with ${cfg.reviewer.probe_model} …`)
    const p = probe({ model: cfg.reviewer.probe_model, root: ROOT })
    if (!p.ok) die(`probe failed: ${p.error}. Retry with --transport inline (payload is inlined; the reviewer needs no tools).`)
  }
  let payload = null
  if (transport === 'inline') {
    payload = collectInline({ root: ROOT, from: mb, files, maxBytes: cfg.inline_max_bytes })
    if (payload.mode === 'over') die(`inline payload is ${payload.bytes} bytes > inline_max_bytes ${cfg.inline_max_bytes} — narrow the scope (--scope) or raise inline_max_bytes`)
    if (payload.mode === 'diff-only') log(`inline payload trimmed to diff only (${payload.bytes} bytes)`)
  }
  const gates = runGates(ROOT, cfg.gates, { tailBytes: cfg.gate_tail_bytes })
  const fresh = { ...bootstrapLedger(cfg), status: 'open', run_id: runId(), base, merge_base: mb, transport, scope: opts.scope || null, scope_globs: scope, rubric_scope: cfg.scopes[opts.scope]?.rubric || null, files, focus: opts.focus || null, reviewer: { engine: 'codex', model, effort, sandbox: cfg.codex_sandbox, thread_id: null }, opened_at: nowIso() }
  const dir = join(REVIEW, 'runs', fresh.run_id)
  mkdirSync(dir, { recursive: true })
  const req = join(dir, 'r1.request.md'), out = join(dir, 'r1.reply.json'), ev = join(dir, 'r1.events.jsonl')
  writeFileSync(req, buildOpenRequest({ rubricCore, rubricRepo, rubricScope, base, mergeBase: mb, focus: fresh.focus, transport, root: ROOT, ...sandboxTargetFor(transport, base, files), payload, gates, scopeName: fresh.scope }))
  log(`R1 ${model}@${effort} transport=${transport} base=${base} files=${files.length} run=${fresh.run_id} … (up to ${cfg.timeout_ms / 60000} min)`)
  const r1Args = openArgs({ model, effort, sandbox: cfg.codex_sandbox, root: ROOT, schema: TEMPLATES.schema, outFile: out })
  const res = runCodex(r1Args, { cwd: ROOT, input: readFileSync(req, 'utf8'), outFile: out, eventsFile: ev, timeout: cfg.timeout_ms, validate: validateReply })
  if (!res.ok) die(`R1 failed (not counted as a round): ${res.error}. Events: ${ev}`)
  if (res.salvaged) log('R1 reply salvaged: codex answered (turn.completed) but hung at exit until the timeout')
  if (!res.threadId) die('R1 returned no thread id (need codex --json thread.started) — cannot resume later')
  // A new thread: any turn_context in it is this call's. Drift here leaves no run behind — the next open starts a fresh thread.
  const seen = verifyReviewer('R1', res.threadId, { model, effort, sandbox: cfg.codex_sandbox }, 0, (msg) => die(`${msg} — reply discarded, no run opened`))
  fresh.reviewer.thread_id = res.threadId
  fresh.round = 1
  const { added, blocking } = assignNewFindings(fresh, res.output.findings, 1)
  fresh.summary = res.output.summary
  computeStatus(fresh, { newBlocking: blocking, insufficient: 0, maintain: 0, reopen: 0, transitions: 0, head: head(ROOT) })
  fresh.history[fresh.history.length - 1].reviewer = seen
  saveLedger(REVIEW, fresh)
  log(`R1 verdict=${res.output.verdict} findings=${added} (blocking ${blocking}) thread=${res.threadId}`)
  printStatus(fresh)
  console.log(nextHint(fresh))
}

function cmdReply(pos, opts) {
  const [id, action] = pos
  if (!id || !AUTHOR_ACTIONS.has(action)) die('usage: reply <id> <fix|reject|dispute|defer> [--reason …] [--evidence …] [--commit sha]')
  const cfg = loadConfig(ROOT)
  const l = loadLedger(REVIEW, cfg)
  if (l.status !== 'open') die(`run is ${l.status}`)
  const f = l.findings.find((x) => x.id === id)
  if (!f) die(`${id} not found`)
  if (!AWAITING_AUTHOR.has(f.status)) die(`${id} is ${f.status} — not awaiting the author`)
  const reason = opts.reason || '', evidence = opts.evidence || ''
  if (action === 'fix' && !evidence && !opts.commit) die('fix needs --evidence (the verification you ran and its result) or --commit')
  if ((action === 'reject' || action === 'dispute') && !/[\w./-]+:\d+|[\w-]+\.\w+/.test(reason)) die(`${action} needs a file:line reference in --reason so the reviewer can trace it`)
  if (action === 'defer') {
    if (isBlocking(l, f)) die(`${id} is ${f.severity} — blocking severities cannot be deferred`)
    if (!reason) die('defer needs --reason (ticket, follow-up)')
  }
  f.author = { round: l.round, action, reason, evidence, commit: opts.commit || null, at: nowIso() }
  f.status = action === 'fix' ? 'fixed_claimed' : action === 'defer' ? 'deferred' : 'rejected_by_author'
  saveLedger(REVIEW, l)
  log(`${id} ← ${action} (${f.status})`)
  const left = l.findings.filter((x) => AWAITING_AUTHOR.has(x.status)).map((x) => x.id)
  console.log(left.length ? `Still awaiting reply: ${left.join(', ')}` : `All replied — ${HINT} round`)
}

function cmdRound(opts) {
  const cfg = loadConfig(ROOT)
  const l = loadLedger(REVIEW, cfg)
  if (l.status !== 'open') die(`run is ${l.status}${l.status === 'idle' ? ` — run ${HINT} open first` : ''}`)
  const pending = l.findings.filter((f) => AWAITING_AUTHOR.has(f.status)).map((f) => f.id)
  if (pending.length) die(`unanswered findings: ${pending.join(', ')} — the reply is the channel`)
  if (!l.reviewer?.thread_id) die('no reviewer thread id — run open again')
  const thread = l.reviewer.thread_id
  // Ledgers opened by ≤0.2.1 did not store the sandbox: recover it from the thread's R1 turn instead of trusting today's config.
  // Done before any payload work so the save below persists only this field.
  if (!l.reviewer.sandbox) {
    const sb = firstSandbox(thread)
    if (!SANDBOXES.has(sb)) die(`ledger has no reviewer.sandbox and the R1 turn of thread ${thread} does not show a known one (${sb ?? 'none'}) — close this run and open a new one`)
    l.reviewer.sandbox = sb
    saveLedger(REVIEW, l)
    log(`reviewer.sandbox recovered from the R1 rollout: ${sb}`)
  }
  const { rubricCore, rubricRepo } = rubrics()
  const effort = opts.effort || (l.findings.some((f) => f.reopened_round) ? cfg.reviewer.effort_reopen : cfg.reviewer.effort_round)
  if (!EFFORTS.has(effort)) die(`effort ${effort} is not allowed`)
  const n = l.round + 1
  const dir = join(REVIEW, 'runs', l.run_id)
  mkdirSync(dir, { recursive: true })
  const req = join(dir, `r${n}.request.md`), out = join(dir, `r${n}.reply.json`), ev = join(dir, `r${n}.events.jsonl`)
  const gates = runGates(ROOT, cfg.gates, { tailBytes: cfg.gate_tail_bytes })
  const delta = l.transport === 'inline' ? inlineDelta(l) : null
  const rubricScope = readScopeRubric(l.rubric_scope, l.scope)
  // The file set is refreshed every round: files added or committed since open must reach the reviewer.
  l.files = changedFiles(ROOT, l.merge_base, l.scope_globs)
  const baseReq = buildRoundRequest({ rubricCore, rubricRepo, rubricScope, ledger: l, transport: l.transport, root: ROOT, ...sandboxTargetFor(l.transport, l.base, l.files), delta, gates })
  const pinned = { model: l.reviewer.model, effort, sandbox: l.reviewer.sandbox }
  let before = 0
  const call = () => {
    before = turnContexts(thread).contexts.length
    const r = runCodex(resumeArgs({ threadId: thread, ...pinned, schema: TEMPLATES.schema, outFile: out }), { cwd: ROOT, input: readFileSync(req, 'utf8'), outFile: out, eventsFile: ev, timeout: cfg.timeout_ms, validate: validateReply })
    if (r.ok && r.threadId !== thread) return { ok: false, error: `resume answered on thread ${r.threadId ?? '(none)'}, not ${thread}` }
    return r
  }
  // The drifted turn already sits in the codex thread and would be context for every later round: stop the run instead of resuming it.
  const drifted = (msg) => {
    l.status = 'escalated'
    l.escalated_note = `${msg} — reply discarded and round not counted, but the drifted turn stays in codex thread ${thread}; close this run and open a new one`
    saveLedger(REVIEW, l)
    die(l.escalated_note)
  }
  writeFileSync(req, baseReq)
  log(`R${n} resume ${thread.slice(0, 8)} ${pinned.model}@${effort} ${pinned.sandbox} …`)
  let res = call()
  if (!res.ok) {
    console.error(`[review-ledger] R${n} failed: ${res.error} — retrying once`)
    res = call()
    if (!res.ok) die(`R${n} retry failed (not counted as a round): ${res.error}. Escalate with ${HINT} escalate`)
  }
  let seen = verifyReviewer(`R${n}`, thread, pinned, before, drifted)
  if (res.salvaged) log(`R${n} reply salvaged: codex answered (turn.completed) but hung at exit until the timeout`)
  let work = structuredClone(l)
  let stats = applyReplies(work, res.output.replies, n)
  if (stats.unanswered.length) {
    console.error(`[review-ledger] R${n} unanswered replies ${stats.unanswered.join(',')}${stats.ignored.length ? ` (ignored verdicts: ${stats.ignored.join(',')})` : ''} — ledger untouched, re-requesting once`)
    writeFileSync(req, baseReq + protocolViolationSuffix(stats.unanswered))
    res = call()
    if (!res.ok) die(`R${n} re-request failed (not counted as a round): ${res.error}. Escalate with ${HINT} escalate`)
    seen = verifyReviewer(`R${n}`, thread, pinned, before, drifted)
    work = structuredClone(l)
    stats = applyReplies(work, res.output.replies, n)
    if (stats.unanswered.length) die(`R${n}: reviewer did not answer ${stats.unanswered.join(',')} (round not counted, ledger unchanged). Run ${HINT} round again or ${HINT} escalate`)
  }
  Object.assign(l, work)
  l.round = n
  const { added, blocking } = assignNewFindings(l, res.output.findings, n)
  l.summary = res.output.summary
  computeStatus(l, { newBlocking: blocking, insufficient: stats.insufficient, maintain: stats.maintain, reopen: stats.reopen, transitions: stats.transitions, head: head(ROOT) })
  l.history[l.history.length - 1].reviewer = seen
  saveLedger(REVIEW, l)
  log(`R${n} verdict=${res.output.verdict} replies=${res.output.replies.length} new=${added} (blocking ${blocking}) insufficient=${stats.insufficient} maintain=${stats.maintain} reopen=${stats.reopen}${stats.ignored.length ? ` ignored=${stats.ignored.join(',')}` : ''}`)
  printStatus(l)
  console.log(nextHint(l))
}

function cmdEscalate(opts) {
  const l = loadLedger(REVIEW, loadConfig(ROOT))
  if (l.status === 'idle') die('no open run')
  l.status = 'escalated'; l.escalated_note = opts.note || null
  saveLedger(REVIEW, l); printStatus(l)
  console.log(`\nShow ${join(REVIEW, 'ledger.md')} to the user.`)
}
function cmdClose(opts) {
  const l = loadLedger(REVIEW, loadConfig(ROOT))
  if (l.status === 'idle') die('no open run')
  for (const f of l.findings) if (!CLOSED.has(f.status)) { f.status = 'closed_by_user'; f.note = opts.note || 'closed by user' }
  l.status = 'closed'; l.closed_at = nowIso()
  saveLedger(REVIEW, l)
  log(`run ${l.run_id} closed (${opts.note || 'no note'})`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { opts, pos } = parseArgs(process.argv.slice(2))
  const cmd = pos.shift()
  // `open --help` used to run a real (billed) review. Help is checked on the raw argv so `--no-probe -h` (parsed as the
  // value of --no-probe) cannot slip through; a literal "-h" option value is not supported.
  const raw = process.argv.slice(2)
  if (raw.some((a) => a === '-h' || a === '--help' || a.startsWith('--help=')) || raw[0] === 'help') { console.log(USAGE); process.exit(0) }
  try {
    switch (cmd) {
      case 'init': cmdInit(opts); break
      case 'open': cmdOpen(opts); break
      case 'reply': cmdReply(pos, opts); break
      case 'round': cmdRound(opts); break
      case 'status': printStatus(loadLedger(REVIEW, loadConfig(ROOT))); break
      case 'escalate': cmdEscalate(opts); break
      case 'close': cmdClose(opts); break
      default: die(`${USAGE}
(plugin root ${PLUGIN_ROOT})`)
    }
  } catch (e) { die(e.message) }
}
