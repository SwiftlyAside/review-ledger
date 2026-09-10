#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit) hook — if the edited file is referenced by an open finding, remind the author to reply before opening a round. Never mutates the ledger.
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.CLAUDE_PROJECT_DIR ? resolve(process.env.CLAUDE_PROJECT_DIR) : process.cwd()
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'review-ledger.mjs')

function main() {
  let data = {}
  try { data = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { return }
  const fp = data.tool_input?.file_path
  if (typeof fp !== 'string') return
  const p = join(ROOT, '.review', 'ledger.json')
  if (!existsSync(p)) return
  const l = JSON.parse(readFileSync(p, 'utf8'))
  if (l.status !== 'open') return
  const rel = relative(ROOT, resolve(fp)).replace(/\\/g, '/')
  const hit = l.findings.filter((f) => ['open', 'fixed_claimed', 'rejected_by_author'].includes(f.status) && (rel === f.file || rel.endsWith('/' + f.file) || String(f.file).endsWith('/' + rel)))
  if (!hit.length) return
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[review-ledger] ${rel} edited — related findings ${hit.map((f) => `${f.id}(${f.status})`).join(', ')}. When done, reply with node "${CLI}" reply <id> fix --evidence "<verification you ran>" and then node "${CLI}" round. Close the whole class, not just this instance.` } }))
}
try { main() } catch { /* silent pass */ }
process.exitCode = 0
