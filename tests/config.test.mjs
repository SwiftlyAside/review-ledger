import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, mergeConfig, validateConfig, loadConfig } from '../scripts/lib/config.mjs'

test('DEFAULT_CONFIG matches the shipped template', () => {
  const tpl = JSON.parse(readFileSync(new URL('../templates/config.json', import.meta.url), 'utf8'))
  assert.deepEqual(mergeConfig({}), tpl)
  assert.equal(DEFAULT_CONFIG.transport, 'sandbox')
  assert.equal(DEFAULT_CONFIG.codex_sandbox, 'read-only')
})

test('mergeConfig: reviewer keys merge shallowly, top-level keys replace', () => {
  const c = mergeConfig({ reviewer: { model: 'x' }, blocking: ['P0'] })
  assert.equal(c.reviewer.model, 'x')
  assert.equal(c.reviewer.effort_open, 'xhigh')
  assert.deepEqual(c.blocking, ['P0'])
})

test('validateConfig: rejects bad effort, transport, sandbox, engine, scopes', () => {
  assert.deepEqual(validateConfig(mergeConfig({})), [])
  assert.match(validateConfig(mergeConfig({ reviewer: { effort_open: 'ultra' } })).join(), /effort_open/)
  assert.match(validateConfig(mergeConfig({ transport: 'ftp' })).join(), /transport/)
  assert.match(validateConfig(mergeConfig({ codex_sandbox: 'yolo' })).join(), /codex_sandbox/)
  assert.match(validateConfig(mergeConfig({ reviewer: { engine: 'claude' } })).join(), /engine/)
  assert.match(validateConfig(mergeConfig({ scopes: { a: {} } })).join(), /scopes\.a/)
  assert.match(validateConfig(mergeConfig({ max_rounds: 0 })).join(), /max_rounds/)
})

test('loadConfig: missing file → defaults; invalid file → throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'rl-cfg-'))
  assert.equal(loadConfig(root).max_rounds, 3)
  mkdirSync(join(root, '.review'))
  writeFileSync(join(root, '.review', 'config.json'), JSON.stringify({ transport: 'inline', max_rounds: 5 }))
  const c = loadConfig(root)
  assert.equal(c.transport, 'inline'); assert.equal(c.max_rounds, 5)
  writeFileSync(join(root, '.review', 'config.json'), JSON.stringify({ transport: 'nope' }))
  assert.throws(() => loadConfig(root), /transport/)
})

test('scopes.<name>.rubric must be a string when present', () => {
  const c = mergeConfig({ scopes: { posts: { include: ['content/**'], rubric: 5 } } })
  assert.ok(validateConfig(c).some((e) => /scopes\.posts\.rubric/.test(e)))
  const ok = mergeConfig({ scopes: { posts: { include: ['content/**'], rubric: '.review/rubric-content.md' } } })
  assert.deepEqual(validateConfig(ok).filter((e) => /rubric/.test(e)), [])
})
