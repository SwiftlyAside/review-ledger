import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const TEMPLATES = {
  config: join(PLUGIN_ROOT, 'templates', 'config.json'),
  rubricCore: join(PLUGIN_ROOT, 'templates', 'rubric.core.md'),
  rubricRepo: join(PLUGIN_ROOT, 'templates', 'rubric.repo.md'),
  schema: join(PLUGIN_ROOT, 'templates', 'review.schema.json'),
}
export const CLI = join(PLUGIN_ROOT, 'scripts', 'review-ledger.mjs')

/** Repo root: CLAUDE_PROJECT_DIR, else git toplevel of cwd, else cwd. */
export function resolveRoot(cwd = process.cwd()) {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR)
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return resolve(cwd) }
}
export function reviewDir(root) { return join(root, '.review') }
