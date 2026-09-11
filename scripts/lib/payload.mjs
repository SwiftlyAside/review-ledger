import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** core.quotepath=off: without it git prints non-ASCII paths as "\354\204..." octal in quotes, which then match no glob and read no file. */
export function git(root, args, fallback = '') {
  try { return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }).trim() } catch { return fallback }
}
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*' }
      else re += '[^/]*'
    } else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}
/** An exclude glob also matches when it equals the first path segment, so `.review` drops `.review/x`. */
export function matchScope(path, scope) {
  const inc = (scope.include || ['**']).map(globToRegExp), exc = (scope.exclude || []).map(globToRegExp)
  const first = path.split('/')[0]
  return inc.some((r) => r.test(path)) && !exc.some((r) => r.test(path) || r.test(first))
}
export function resolveScope(config, name) {
  const base = { include: ['**'], exclude: [...(config.exclude || [])] }
  if (!name) return base
  const s = config.scopes?.[name]
  if (!s) throw new Error(`unknown scope "${name}" (known: ${Object.keys(config.scopes || {}).join(', ') || 'none'})`)
  return { include: [...s.include], exclude: [...base.exclude, ...(s.exclude || [])] }
}
export function mergeBase(root, base) { return git(root, ['merge-base', base, 'HEAD']) || null }
export function head(root) { return git(root, ['rev-parse', 'HEAD']) }
export function untrackedFiles(root) { return new Set(git(root, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean)) }
export function changedFiles(root, from, scope) {
  const tracked = git(root, ['diff', '--name-only', from]).split(/\r?\n/)
  return [...new Set([...tracked, ...untrackedFiles(root)])].filter(Boolean).filter((p) => matchScope(p, scope)).sort()
}
export function diffText(root, from, files) { return files.length ? git(root, ['diff', from, '--', ...files]) : '' }
export function readEntry(root, p) {
  const abs = join(root, p)
  if (!existsSync(abs) || statSync(abs).isDirectory()) return null
  const buf = readFileSync(abs)
  return buf.includes(0) ? { path: p, content: null, binary: true } : { path: p, content: buf.toString('utf8'), binary: false }
}
export function collectInline({ root, from, files, maxBytes }) {
  const diff = diffText(root, from, files)
  const contents = files.map((p) => readEntry(root, p)).filter(Boolean)
  const diffBytes = Buffer.byteLength(diff)
  const fullBytes = diffBytes + contents.reduce((n, f) => n + (f.content ? Buffer.byteLength(f.content) : 0), 0)
  if (fullBytes <= maxBytes) return { diff, files: contents, mode: 'full', bytes: fullBytes }
  if (diffBytes <= maxBytes) return { diff, files: contents, mode: 'diff-only', bytes: diffBytes }
  return { diff, files: contents, mode: 'over', bytes: diffBytes }
}
const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`
/** Diff limited to the in-scope tracked files (so `--scope` survives the sandbox transport); null when nothing tracked changed. */
export function sandboxDiffCommand(base, tracked) {
  return tracked.length ? `git diff $(git merge-base ${base} HEAD) -- ${tracked.map(shq).join(' ')}` : null
}
/** Sandbox target for one round: tracked files go into the diff command, untracked ones are listed for full reads (git diff cannot show them). */
export function sandboxTarget(root, base, files) {
  const u = untrackedFiles(root)
  const tracked = files.filter((f) => !u.has(f)), untracked = files.filter((f) => u.has(f))
  return { diffCommand: sandboxDiffCommand(base, tracked), tracked, untracked }
}
