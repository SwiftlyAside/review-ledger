import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// REVIEW_LEDGER_CODEX_BIN overrides the executable; REVIEW_LEDGER_CODEX_PREFIX is prepended to the args (tests: node fake-codex.mjs …).
export function codexBin() { return process.env.REVIEW_LEDGER_CODEX_BIN || 'codex' }
export function codexPrefix() { const p = process.env.REVIEW_LEDGER_CODEX_PREFIX; return p ? [p] : [] }

export function openArgs({ model, effort, sandbox, root, schema, outFile }) {
  const extra = sandbox === 'danger-full-access' ? ['-c', 'approval_policy="never"'] : []
  return ['exec', '-m', model, '-c', `model_reasoning_effort="${effort}"`, '-s', sandbox, ...extra, '-C', root, '--skip-git-repo-check', '--json', '--output-schema', schema, '-o', outFile, '-']
}
/** `codex exec resume` inherits model and sandbox from the thread and rejects -m / -s. */
export function resumeArgs({ threadId, effort, schema, outFile }) {
  return ['exec', 'resume', threadId, '-c', `model_reasoning_effort="${effort}"`, '--json', '--output-schema', schema, '-o', outFile, '-']
}
export function parseThreadId(stdout) {
  for (const line of (stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try { const ev = JSON.parse(line); if (ev.type === 'thread.started' && ev.thread_id) return ev.thread_id } catch { /* skip */ }
  }
  return null
}
const tailStderr = (s) => (s || '').split('\n').filter((x) => x.trim() && !/ERROR rmcp|failed to load skill/.test(x)).slice(-5).join(' | ')

export function runCodex(args, { cwd, input, outFile, eventsFile, timeout, validate, spawnSync = nodeSpawnSync }) {
  const res = spawnSync(codexBin(), [...codexPrefix(), ...args], { cwd, input, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 })
  if (res.stdout && eventsFile) writeFileSync(eventsFile, res.stdout)
  const threadId = parseThreadId(res.stdout)
  if (res.error) return { ok: false, threadId, error: res.error.code === 'ETIMEDOUT' ? `timeout after ${timeout} ms` : String(res.error.message || res.error) }
  if (res.status !== 0) return { ok: false, threadId, error: `codex exit ${res.status}: ${tailStderr(res.stderr)}` }
  if (!existsSync(outFile)) return { ok: false, threadId, error: 'no output file' }
  let parsed
  try { parsed = JSON.parse(readFileSync(outFile, 'utf8')) } catch (e) { return { ok: false, threadId, error: `output is not JSON: ${e.message}` } }
  const v = validate ? validate(parsed) : null
  if (v) return { ok: false, threadId, error: `schema: ${v}` }
  return { ok: true, threadId, output: parsed }
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
