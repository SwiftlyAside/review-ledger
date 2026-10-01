import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// REVIEW_LEDGER_CODEX_BIN overrides the executable; REVIEW_LEDGER_CODEX_PREFIX is prepended to the args (tests: node fake-codex.mjs …).
export function codexBin() { return process.env.REVIEW_LEDGER_CODEX_BIN || 'codex' }
export function codexPrefix() { const p = process.env.REVIEW_LEDGER_CODEX_PREFIX; return p ? [p] : [] }

const approvalExtra = (sandbox) => sandbox === 'danger-full-access' ? ['-c', 'approval_policy="never"'] : []
export function openArgs({ model, effort, sandbox, root, schema, outFile }) {
  return ['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-s', sandbox, ...approvalExtra(sandbox), '-C', root, '--skip-git-repo-check', '--json', '--output-schema', schema, '-o', outFile, '-']
}
/**
 * `codex exec resume` does NOT inherit model or sandbox from the thread: without -m it falls back to the machine default model,
 * and the sandbox to the machine default (observed 2026-09-12…10-01: R1 gpt-5.6-sol/danger-full-access → R2 gpt-6-astra/workspace-write).
 * resume accepts -m but not -s, so the sandbox is pinned through the sandbox_mode config key.
 */
export function resumeArgs({ threadId, model, effort, sandbox, schema, outFile }) {
  if (!model || !sandbox) throw new Error('resumeArgs needs model and sandbox — resume does not inherit them from the thread')
  return ['exec', 'resume', threadId, '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-c', `sandbox_mode="${sandbox}"`, ...approvalExtra(sandbox), '--json', '--output-schema', schema, '-o', outFile, '-']
}

export function codexHome() { return process.env.CODEX_HOME || join(homedir(), '.codex') }
/** The thread's newest rollout-*-<threadId>.jsonl under <CODEX_HOME>/sessions/YYYY/MM/DD, or null (the caller reports UNVERIFIED). */
export function findRollout(threadId, home = codexHome()) { return findRollouts(threadId, home).at(-1) ?? null }
/** Every rollout file of the thread, oldest first (YYYY/MM/DD, then file name = start timestamp). Unreadable directories are skipped. */
export function findRollouts(threadId, home = codexHome()) {
  const ls = (dir, dirs) => { try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() === dirs).map((d) => d.name).sort() } catch { return [] } }
  const sessions = join(home, 'sessions'), out = []
  for (const y of ls(sessions, true)) for (const m of ls(join(sessions, y), true)) for (const d of ls(join(sessions, y, m), true)) {
    for (const f of ls(join(sessions, y, m, d), false)) if (f.startsWith('rollout-') && f.endsWith(`-${threadId}.jsonl`)) out.push(join(sessions, y, m, d, f))
  }
  return out
}
/**
 * The sandbox of the thread's first turn (R1) = the first turn_context of the oldest rollout file. Never falls back to a later
 * turn or file: those may run under another sandbox, so an unreadable or sandbox-less R1 context yields null (caller refuses).
 */
export function firstSandbox(threadId, home = codexHome()) {
  const oldest = findRollouts(threadId, home)[0]
  return (oldest && readContexts(oldest)?.[0]?.sandbox) || null
}
function readContexts(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  const contexts = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"turn_context"')) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'turn_context' && ev.payload) contexts.push({ model: ev.payload.model ?? null, effort: ev.payload.effort ?? null, sandbox: ev.payload.sandbox_policy?.type ?? null })
    } catch { /* skip */ }
  }
  return contexts
}
/** Every turn_context of the thread's newest rollout, oldest first, as { model, effort, sandbox } (null fields when codex did not record them). */
export function turnContexts(threadId, home = codexHome()) {
  const file = findRollout(threadId, home)
  if (!file) return { file: null, contexts: [] }
  const contexts = readContexts(file)
  return contexts ? { file, contexts } : { file: null, contexts: [] }
}
/**
 * Compare the thread's newest turn_context with the pinned values. `before` = turn_context count taken right before the call:
 * the turn just run must have added one, otherwise an older turn would be checked.
 * Returns { unverified: reason } when there is nothing trustworthy to compare (no rollout, no new turn, a field missing),
 * else { observed, drift } with drift = null when model, effort and sandbox all match, or a "field got (pinned want)" list.
 */
export function checkDrift(threadId, { model, effort, sandbox }, { before = 0, home = codexHome() } = {}) {
  const { file, contexts } = turnContexts(threadId, home)
  if (!file) return { unverified: 'no codex rollout for the thread' }
  if (contexts.length <= before) return { unverified: `no new turn_context in ${file}` }
  const ctx = { ...contexts[contexts.length - 1], file }
  const missing = ['model', 'effort', 'sandbox'].filter((k) => typeof ctx[k] !== 'string' || !ctx[k])
  if (missing.length) return { unverified: `turn_context lacks ${missing.join(', ')} in ${file}` }
  const bad = [['model', model, ctx.model], ['effort', effort, ctx.effort], ['sandbox', sandbox, ctx.sandbox]].filter(([, want, got]) => want !== got)
  return { observed: ctx, drift: bad.length ? bad.map(([k, want, got]) => `${k} ${got} (pinned ${want})`).join(', ') : null }
}
export function parseThreadId(stdout) {
  for (const line of (stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try { const ev = JSON.parse(line); if (ev.type === 'thread.started' && ev.thread_id) return ev.thread_id } catch { /* skip */ }
  }
  return null
}
const tailStderr = (s) => (s || '').split('\n').filter((x) => x.trim() && !/ERROR rmcp|failed to load skill/.test(x)).slice(-5).join(' | ')

/** True when the --json stream carries a finished turn (codex has answered even if the process never exited). */
export function turnCompleted(stdout) {
  for (const line of (stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try { if (JSON.parse(line).type === 'turn.completed') return true } catch { /* skip */ }
  }
  return false
}

export function runCodex(args, { cwd, input, outFile, eventsFile, timeout, validate, spawnSync = nodeSpawnSync }) {
  // A reply file left by an earlier attempt (failed, discarded for drift) must never pass for this call's answer.
  rmSync(outFile, { force: true })
  const res = spawnSync(codexBin(), [...codexPrefix(), ...args], { cwd, input, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 })
  if (res.stdout && eventsFile) writeFileSync(eventsFile, res.stdout)
  const threadId = parseThreadId(res.stdout)
  // A timed-out process that already emitted turn.completed and a valid output file has answered — the hang is at exit,
  // not in the review (observed 2026-09-10: 20-minute wait after a 271-token reply). Salvage instead of re-running the round.
  const salvage = res.error?.code === 'ETIMEDOUT' && turnCompleted(res.stdout)
  if (res.error && !salvage) return { ok: false, threadId, error: res.error.code === 'ETIMEDOUT' ? `timeout after ${timeout} ms` : String(res.error.message || res.error) }
  if (!salvage && res.status !== 0) return { ok: false, threadId, error: `codex exit ${res.status}: ${tailStderr(res.stderr)}` }
  if (!existsSync(outFile)) return { ok: false, threadId, error: 'no output file' }
  let parsed
  try { parsed = JSON.parse(readFileSync(outFile, 'utf8')) } catch (e) { return { ok: false, threadId, error: `output is not JSON: ${e.message}` } }
  const v = validate ? validate(parsed) : null
  if (v) return { ok: false, threadId, error: `schema: ${v}` }
  return { ok: true, threadId, output: parsed, salvaged: salvage || undefined }
}

/** 30-second liveness check of the read-only sandbox: can the reviewer run a shell command at all? */
export function probe({ model, root, timeout = 30000, spawnSync = nodeSpawnSync }) {
  const args = ['exec', '-m', model, '-c', 'model_reasoning_effort="low"', '-s', 'read-only', '-C', root, '--skip-git-repo-check', '-']
  const res = spawnSync(codexBin(), [...codexPrefix(), ...args], { cwd: root, input: 'Run exactly this shell command and reply with its output only: git log --oneline -1', encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 })
  if (res.error) return { ok: false, error: res.error.code === 'ETIMEDOUT' ? 'probe timeout' : String(res.error.message || res.error) }
  const out = `${res.stdout || ''}\n${res.stderr || ''}`
  if (/deny-read ACLs|helper_unknown_error/.test(out)) return { ok: false, error: 'sandbox exec is broken on this machine (deny-read ACLs)' }
  if (res.status !== 0) return { ok: false, error: `probe exit ${res.status}: ${tailStderr(res.stderr)}` }
  return { ok: true }
}
