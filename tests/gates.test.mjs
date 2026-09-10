import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runGates, renderGates } from '../scripts/lib/gates.mjs'

test('runGates runs each command through the shell and captures exit + tail', () => {
  const r = runGates(process.cwd(), [`node -e "console.log('gate-ok')"`, `node -e "process.exit(3)"`], { tailBytes: 50 })
  assert.equal(r[0].code, 0); assert.match(r[0].tail, /gate-ok/)
  assert.equal(r[1].code, 3)
  const md = renderGates(r)
  assert.match(md, /## Deterministic gates/); assert.match(md, /exit 0/); assert.match(md, /exit 3/)
  assert.equal(renderGates([]), '')
})

test('runGates keeps only the tail', () => {
  const r = runGates(process.cwd(), [`node -e "console.log('x'.repeat(200))"`], { tailBytes: 20 })
  assert.ok(r[0].tail.startsWith('…')); assert.ok(r[0].tail.length <= 21)
})
