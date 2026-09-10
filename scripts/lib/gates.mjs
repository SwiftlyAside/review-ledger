import { spawnSync } from 'node:child_process'

/** Run each gate command through the shell; capture exit code and an output tail. Never throws. */
export function runGates(root, gates, { tailBytes = 4000, timeout = 600000 } = {}) {
  return gates.map((cmd) => {
    const r = spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 })
    const out = `${r.stdout || ''}${r.stderr ? '\n' + r.stderr : ''}`.trim()
    return { cmd, code: r.error ? -1 : r.status, tail: out.length > tailBytes ? '…' + out.slice(-tailBytes) : out, error: r.error ? String(r.error.message) : null }
  })
}
export function renderGates(results) {
  if (!results.length) return ''
  return ['## Deterministic gates (run by the orchestrator just before this round)', ...results.map((g) => `### \`${g.cmd}\` → exit ${g.code}${g.error ? ` (${g.error})` : ''}\n\`\`\`\n${g.tail || '(no output)'}\n\`\`\``), ''].join('\n')
}
