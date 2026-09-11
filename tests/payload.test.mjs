import { test } from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, matchScope, resolveScope, changedFiles, mergeBase, collectInline, sandboxDiffCommand, sandboxTarget } from '../scripts/lib/payload.mjs'
import { mergeConfig } from '../scripts/lib/config.mjs'
import { makeRepo, write } from './helpers/tmp-repo.mjs'

test('globToRegExp: **, *, ?', () => {
  assert.ok(globToRegExp('src/**/*.js').test('src/a/b/c.js'))
  assert.ok(globToRegExp('src/**/*.js').test('src/c.js'))
  assert.ok(!globToRegExp('src/*.js').test('src/a/c.js'))
  assert.ok(globToRegExp('**').test('anything/at/all'))
  assert.ok(globToRegExp('a?.md').test('ab.md'))
  assert.ok(!globToRegExp('a.md').test('aXmd'))
})

test('resolveScope: default is everything minus config.exclude; named scope adds include/exclude; unknown throws', () => {
  const cfg = mergeConfig({ scopes: { docs: { include: ['docs/**'], exclude: ['docs/gen/**'] } } })
  assert.deepEqual(resolveScope(cfg, null), { include: ['**'], exclude: ['.review/ledger.json', '.review/ledger.md', '.review/runs/**'] })
  const s = resolveScope(cfg, 'docs')
  assert.ok(matchScope('docs/a.md', s)); assert.ok(!matchScope('docs/gen/x.md', s)); assert.ok(!matchScope('src/a.js', s))
  assert.throws(() => resolveScope(cfg, 'nope'), /unknown scope "nope"/)
})

test('changedFiles: tracked diffs + untracked, filtered by scope, sorted; collectInline modes', () => {
  const { root, run } = makeRepo()
  run(['checkout', '-q', '-b', 'feat'])
  write(root, 'src/a.js', 'const a = 1\n'); write(root, 'docs/x.md', 'x\n'); write(root, '.review/ledger.json', '{}')
  run(['add', 'src/a.js']); run(['commit', '-q', '-m', 'a'])
  write(root, 'src/a.js', 'const a = 2\n')
  const mb = mergeBase(root, 'main')
  const all = changedFiles(root, mb, { include: ['**'], exclude: ['.review'] })
  assert.deepEqual(all, ['docs/x.md', 'src/a.js'])
  assert.deepEqual(changedFiles(root, mb, { include: ['src/**'], exclude: [] }), ['src/a.js'])
  const full = collectInline({ root, from: mb, files: all, maxBytes: 100000 })
  assert.equal(full.mode, 'full'); assert.match(full.diff, /\+const a = 2/); assert.equal(full.files.length, 2)
  assert.equal(full.files.find((f) => f.path === 'docs/x.md').content, 'x\n')
  const diffOnly = collectInline({ root, from: mb, files: all, maxBytes: full.bytes - 1 })
  assert.equal(diffOnly.mode, 'diff-only')
  assert.equal(collectInline({ root, from: mb, files: all, maxBytes: 5 }).mode, 'over')
})

test('changedFiles: non-ASCII paths are returned unquoted (core.quotepath) for tracked, untracked and the inline diff', () => {
  const { root, run } = makeRepo()
  run(['checkout', '-q', '-b', 'feat'])
  write(root, 'lorebook/01-설정집.md', '본문\n'); run(['add', '-A']); run(['commit', '-q', '-m', 'k'])
  write(root, 'characters/02-캐릭터.md', '카드\n')
  const mb = mergeBase(root, 'main')
  const files = changedFiles(root, mb, { include: ['**'], exclude: [] })
  assert.deepEqual(files, ['characters/02-캐릭터.md', 'lorebook/01-설정집.md'])
  assert.deepEqual(changedFiles(root, mb, { include: ['lorebook/**'], exclude: [] }), ['lorebook/01-설정집.md'])
  const full = collectInline({ root, from: mb, files, maxBytes: 100000 })
  assert.equal(full.mode, 'full')
  assert.match(full.diff, /a\/lorebook\/01-설정집\.md/)
  assert.equal(full.files.find((f) => f.path === 'lorebook/01-설정집.md').content, '본문\n')
})

test('sandboxDiffCommand: diff limited to the given tracked files, shell-quoted; null when there is nothing tracked', () => {
  assert.equal(sandboxDiffCommand('origin/main', ['src/a.js', "we'ird/설정.md"]), "git diff $(git merge-base origin/main HEAD) -- 'src/a.js' 'we'\\''ird/설정.md'")
  assert.equal(sandboxDiffCommand('origin/main', []), null)
})

test('sandboxTarget: scope include survives, untracked in-scope files are listed separately (git diff cannot show them)', () => {
  const { root, run } = makeRepo()
  run(['checkout', '-q', '-b', 'feat'])
  write(root, 'src/a.js', 'const a = 1\n'); run(['add', '-A']); run(['commit', '-q', '-m', 'a'])
  write(root, 'src/c.js', 'new\n'); write(root, 'docs/x.md', 'x\n')
  const mb = mergeBase(root, 'main')
  const files = changedFiles(root, mb, { include: ['src/**'], exclude: [] })
  assert.deepEqual(files, ['src/a.js', 'src/c.js'])
  const t = sandboxTarget(root, 'main', files)
  assert.deepEqual(t.tracked, ['src/a.js']); assert.deepEqual(t.untracked, ['src/c.js'])
  assert.equal(t.diffCommand, "git diff $(git merge-base main HEAD) -- 'src/a.js'")
  assert.ok(!t.diffCommand.includes('docs/x.md'))
  const onlyNew = sandboxTarget(root, 'main', ['src/c.js'])
  assert.equal(onlyNew.diffCommand, null); assert.deepEqual(onlyNew.untracked, ['src/c.js'])
})
