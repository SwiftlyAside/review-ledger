import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'rl-repo-'))
  const run = (args, input) => execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 't@example.com']); run(['config', 'user.name', 'T'])
  run(['config', 'core.autocrlf', 'false'])
  write(root, 'README.md', '# t\n')
  run(['add', '-A']); run(['commit', '-q', '-m', 'init'])
  return { root, run }
}
export function write(root, rel, content) {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}
