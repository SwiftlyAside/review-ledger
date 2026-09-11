import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export const TRANSPORTS = new Set(['sandbox', 'inline'])
export const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

export const DEFAULT_CONFIG = Object.freeze({
  reviewer: Object.freeze({ engine: 'codex', model: 'gpt-5.6-sol', effort_open: 'xhigh', effort_round: 'medium', effort_reopen: 'high', probe_model: 'gpt-5.6-terra' }),
  base: 'origin/main',
  blocking: ['P0', 'P1'],
  max_rounds: 3,
  clean_rounds_required: 1,
  timeout_ms: 1200000,
  transport: 'sandbox',
  codex_sandbox: 'read-only',
  probe: true,
  inline_max_bytes: 400000,
  gate_tail_bytes: 4000,
  exclude: ['.review/ledger.json', '.review/ledger.md', '.review/runs/**'],
  scopes: {},
  gates: [],
})

export function mergeConfig(user = {}) {
  const c = structuredClone(DEFAULT_CONFIG)
  for (const [k, v] of Object.entries(user)) {
    if (k === 'reviewer' && v && typeof v === 'object') Object.assign(c.reviewer, v)
    else c[k] = v
  }
  return c
}

export function validateConfig(c) {
  const errs = []
  for (const k of ['effort_open', 'effort_round', 'effort_reopen']) if (!EFFORTS.has(c.reviewer?.[k])) errs.push(`reviewer.${k}: ${c.reviewer?.[k]}`)
  if (c.reviewer?.engine !== 'codex') errs.push(`reviewer.engine: ${c.reviewer?.engine} (only "codex" is supported)`)
  if (typeof c.reviewer?.model !== 'string' || !c.reviewer.model) errs.push('reviewer.model must be a non-empty string')
  if (!TRANSPORTS.has(c.transport)) errs.push(`transport: ${c.transport}`)
  if (!SANDBOXES.has(c.codex_sandbox)) errs.push(`codex_sandbox: ${c.codex_sandbox}`)
  if (!Array.isArray(c.blocking) || !c.blocking.every((s) => /^P[0-3]$/.test(s))) errs.push('blocking must be a list of P0..P3')
  if (!Number.isInteger(c.max_rounds) || c.max_rounds < 1) errs.push('max_rounds must be an integer ≥ 1')
  if (!Number.isInteger(c.clean_rounds_required) || c.clean_rounds_required < 1) errs.push('clean_rounds_required must be an integer ≥ 1')
  if (!Number.isInteger(c.timeout_ms) || c.timeout_ms < 1000) errs.push('timeout_ms must be ≥ 1000')
  if (!Number.isInteger(c.inline_max_bytes) || c.inline_max_bytes < 1) errs.push('inline_max_bytes must be ≥ 1')
  if (!Array.isArray(c.exclude) || !c.exclude.every((g) => typeof g === 'string')) errs.push('exclude must be string[]')
  if (!Array.isArray(c.gates) || !c.gates.every((g) => typeof g === 'string')) errs.push('gates must be string[]')
  for (const [n, s] of Object.entries(c.scopes || {})) {
    if (!s || !Array.isArray(s.include) || !s.include.every((g) => typeof g === 'string')) errs.push(`scopes.${n}.include must be string[]`)
    if (s?.exclude && !Array.isArray(s.exclude)) errs.push(`scopes.${n}.exclude must be string[]`)
    if (s?.rubric !== undefined && typeof s.rubric !== 'string') errs.push(`scopes.${n}.rubric must be a string path`)
  }
  return errs
}

export function loadConfig(root) {
  const p = join(root, '.review', 'config.json')
  let user = {}
  if (existsSync(p)) {
    try { user = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { throw new Error(`.review/config.json is not valid JSON: ${e.message}`) }
  }
  const c = mergeConfig(user)
  const errs = validateConfig(c)
  if (errs.length) throw new Error(`invalid .review/config.json: ${errs.join('; ')}`)
  return c
}
