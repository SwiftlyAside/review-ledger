import { renderGates } from './gates.mjs'
import { FROZEN } from './ledger.mjs'

export const TOOLING_BLOCK = `<tooling>
Do not call any tool: no shell, no file reads, no skill lookups, no web. Everything you need is in this message.
Your first output is your final answer. Start directly with the JSON required by the output schema; no plan sentences.
</tooling>`

const fileBlock = (f) => [`## File: ${f.path}`, ...(f.binary ? ['(binary — omitted)'] : ['```', f.content, '```']), '']

export function renderPayload(p) {
  const parts = ['## Diff against merge-base', '```diff', p.diff || '(no diff — new files only)', '```', '']
  if (p.mode === 'full') for (const f of p.files) parts.push(...fileBlock(f))
  else parts.push('(file bodies omitted: payload exceeded inline_max_bytes; diff only)', '')
  return parts.join('\n')
}

function header({ rubricCore, rubricRepo, rubricScope = '', transport }) {
  const h = [rubricCore.trim(), '', rubricRepo.trim(), '']
  if (rubricScope) h.push(rubricScope.trim(), '')
  return transport === 'inline' ? [TOOLING_BLOCK, '', ...h] : h
}

const untrackedLine = (u) => `Untracked in-scope files (not in any diff — read each in full): ${u.map((f) => `\`${f}\``).join(', ')}.`
function sandboxLines({ root, diffCommand, untracked, verb }) {
  const out = [`Repository root: ${root}.`]
  if (diffCommand) out.push(`${verb} \`${diffCommand}\` yourself (read-only); it is limited to the in-scope tracked files.`)
  if (untracked.length) out.push(untrackedLine(untracked))
  out.push('Files outside this list are context, not review targets; read any file you need for context.')
  return [out.join(' ')]
}

export function buildOpenRequest({ rubricCore, rubricRepo, rubricScope = '', base, mergeBase, focus, transport, root, diffCommand, untracked = [], payload, gates = [], scopeName = null }) {
  const target = ['## Target', `Base: \`${base}\` (merge-base ${mergeBase.slice(0, 7)}).${scopeName ? ` Scope: \`${scopeName}\`.` : ''}`]
  if (focus) target.push(`Author focus: ${focus}`)
  if (transport === 'sandbox') target.push(...sandboxLines({ root, diffCommand, untracked, verb: 'Run' }))
  else target.push('The diff and the full content of every changed in-scope file are inlined below. Cite `file` exactly as shown in the `## File:` headers.')
  return [...header({ rubricCore, rubricRepo, rubricScope, transport }), ...target, '', ...(transport === 'inline' ? [renderPayload(payload)] : []), renderGates(gates), 'Round 1: report findings; leave `replies` empty.', ''].join('\n')
}

function findingBlock(f) {
  return [
    `### ${f.id} (${f.severity}) ${f.file}:${f.line_start}-${f.line_end} — ${f.title}`,
    `anchor: \`${f.anchor}\``,
    `AUTHOR ACTION: ${f.author.action}${f.author.commit ? ` (commit ${f.author.commit})` : ''}`,
    f.author.reason ? `REASON: ${f.author.reason}` : '',
    f.author.evidence ? `EVIDENCE: ${f.author.evidence}` : '',
    f.reviewer?.verdict === 'maintain' ? `(you already answered maintain once: ${f.reviewer.reason})` : '',
  ].filter(Boolean).join('\n')
}

export function buildRoundRequest({ rubricCore, rubricRepo, rubricScope = '', ledger, transport, root, diffCommand, untracked = [], delta, gates = [] }) {
  const replied = ledger.findings.filter((f) => ['fixed_claimed', 'rejected_by_author'].includes(f.status))
  const frozen = ledger.findings.filter((f) => FROZEN.has(f.status))
  const verified = ledger.findings.filter((f) => f.status === 'fixed_verified')
  const disputed = ledger.findings.filter((f) => f.status === 'disputed')
  const n = ledger.round + 1
  const state = transport === 'sandbox'
    ? [...sandboxLines({ root, diffCommand, untracked, verb: 'Re-run' }), 'Verify each reply at its file/anchor.']
    : [`## Changes since round ${ledger.round} (diff from ${delta.from.slice(0, 7)})`, '```diff', delta.diff || '(no diff)', '```', '', ...delta.newFiles.flatMap(fileBlock)]
  return [
    ...header({ rubricCore, rubricRepo, rubricScope, transport }),
    `## Round ${n}`, ...state, '',
    '## Author replies (answer EVERY id below with exactly one verdict)', ...(replied.length ? replied.map(findingBlock) : ['(none)']), '',
    '## Frozen (do not re-raise; `reopen` only with new evidence)', ...(frozen.length ? frozen.map((f) => `- ${f.id} [${f.status}] ${f.title}`) : ['(none)']), '',
    '## Already verified', ...(verified.length ? verified.map((f) => `- ${f.id} ${f.title}`) : ['(none)']),
    ...(disputed.length ? ['', '## Disputed (awaiting the user; do not answer again)', ...disputed.map((f) => `- ${f.id} ${f.title}`)] : []), '',
    renderGates(gates),
    'Then report NEW findings only (different anchor from every id above).', '',
  ].join('\n')
}

export function protocolViolationSuffix(ids) {
  return `\n## Protocol violation\nYour previous reply omitted or mis-stated verdicts for: ${ids.join(', ')}. Answer EVERY id under "Author replies" with a verdict valid for its state (fix → accept_fix|fix_insufficient|withdraw; reject/dispute → accept_rejection|maintain|withdraw).\n`
}
