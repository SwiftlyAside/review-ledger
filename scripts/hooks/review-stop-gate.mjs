#!/usr/bin/env node
// Stop hook — while .review/ledger.json is `open` with unresolved blocking findings, block the turn from ending and say what to do next.
// capped/escalated/stalled need the user, so they pass with a stderr note. stop_hook_active always passes (no infinite loop). Any failure passes silently.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd()
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-ledger.mjs')
const CLOSED = new Set(['fixed_verified', 'rejected_accepted', 'withdrawn', 'deferred', 'closed_by_user'])

function main() {
  let data = {}
  try { data = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { return }
  if (data.stop_hook_active) return
  const p = join(ROOT, '.review', 'ledger.json')
  if (!existsSync(p)) return
  const l = JSON.parse(readFileSync(p, 'utf8'))
  if (l.status !== 'open') {
    if (['capped', 'escalated', 'stalled'].includes(l.status)) process.stderr.write(`[review-ledger] run ${l.run_id} is ${l.status} — show .review/ledger.md to the user and record their decision with node "${CLI}" close --note "…"\n`)
    return
  }
  const bo = l.findings.filter((f) => l.config.blocking.includes(f.severity) && !CLOSED.has(f.status))
  if (!bo.length) return
  const awaiting = bo.filter((f) => f.status === 'open').map((f) => f.id)
  const reason = `Review loop not converged (run ${l.run_id}, round ${l.round}/${l.config.max_rounds}): blocking findings ${bo.map((f) => `${f.id}(${f.severity}:${f.status})`).join(', ')}. ${awaiting.length ? `First reply: node "${CLI}" reply ${awaiting[0]} <fix|reject|dispute> …, then ` : ''}node "${CLI}" round. To hand the decision to the user: node "${CLI}" escalate.`
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}
try { main() } catch { /* silent pass */ }
process.exitCode = 0
