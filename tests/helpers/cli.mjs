import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../../scripts/review-loop.mjs', import.meta.url))
export const FAKE = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url))

export function cli(root, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, REVIEW_LOOP_CODEX_BIN: process.execPath, REVIEW_LOOP_CODEX_PREFIX: FAKE, FAKE_CODEX_SCENARIO: root + '.scenario.json', FAKE_CODEX_STATE: root + '.scenario.state', ...extraEnv } })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}
export function scenario(root, steps) { writeFileSync(root + '.scenario.json', JSON.stringify(steps)); if (existsSync(root + '.scenario.state')) writeFileSync(root + '.scenario.state', '0') }
export function ledger(root) { return JSON.parse(readFileSync(join(root, '.review', 'ledger.json'), 'utf8')) }
export function calls(root) { return existsSync(root + '.scenario.state') ? Number(readFileSync(root + '.scenario.state', 'utf8')) : 0 }
export const finding = (o = {}) => ({ temp_id: 't', severity: 'P1', confidence: 0.9, file: 'src/a.js', line_start: 1, line_end: 1, anchor: 'const a = 2', title: 'Wrong constant', body: 'b', recommendation: 'r', evidence_kind: 'inference', ...o })
export const reply = (findings = [], replies = [], verdict = 'needs-attention') => ({ reply: { verdict, summary: 's', findings, replies } })
