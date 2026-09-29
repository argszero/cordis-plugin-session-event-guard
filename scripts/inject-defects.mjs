/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * the harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first; a
 * mutation that is never written to `lib/` is a mutation the suite cannot see. A
 * mutation that does not compile is reported separately as TYPEFAIL, because it
 * never reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped: one
 * distinction it exists to make, removed one line at a time. The arms are not
 * "does the test file import the module" — each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a claim the package makes
 * that nothing checks.
 *
 * ```sh
 * node scripts/inject-defects.mjs                     # every arm
 * node scripts/inject-defects.mjs --filter=vocabulary # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    name: 'vocabulary: any truthy marker is read as the marker',
    file: 'src/vocabulary.ts',
    edits: [["return ignorable === true ? 'omittable' : 'required'", "return ignorable ? 'omittable' : 'required'"]],
  },
  {
    name: 'vocabulary: the marker is allowed to downgrade a declared type',
    file: 'src/vocabulary.ts',
    edits: [[
      "  if (KNOWN_EVENT_TYPES.has(type)) return 'known'\n  return ignorable === true ? 'omittable' : 'required'",
      "  if (ignorable === true) return 'omittable'\n  return KNOWN_EVENT_TYPES.has(type) ? 'known' : 'required'",
    ]],
  },
  {
    name: 'vocabulary: the build that answered is no longer disclosed',
    file: 'src/vocabulary.ts',
    edits: [["    return typeof version === 'string' ? version : 'unknown'", "    return 'unknown'"]],
  },
  {
    name: 'classify: the seam path is judged as if the marker were absent',
    file: 'src/classify.ts',
    edits: [['const seam = standingOf(type, true)', 'const seam = standingOf(type)']],
  },
  {
    name: 'classify: every type is reported as in the vocabulary',
    file: 'src/classify.ts',
    edits: [['  if (inVocabulary) {', '  if (true) {']],
  },
  {
    // The limitation is modelled as a value, not a comment; flipping it is the
    // defect the whole package is written against. The interface is widened in
    // the same arm so the mutation is a wrong program rather than a type error.
    name: 'classify: the append limitation is reported as surmountable',
    file: 'src/classify.ts',
    edits: [
      ['   * assert it against the real call rather than against this prose.\n   */\n  appendCanMarkOmittable: false',
        '   * assert it against the real call rather than against this prose.\n   */\n  appendCanMarkOmittable: boolean'],
      ['    appendCanMarkOmittable: false,\n    seam,\n    verdict: \'seam-required\',', '    appendCanMarkOmittable: true,\n    seam,\n    verdict: \'seam-required\','],
    ],
  },
  {
    name: 'classify: the append limitation is reported as surmountable on a declared type too',
    file: 'src/classify.ts',
    edits: [
      ['   * assert it against the real call rather than against this prose.\n   */\n  appendCanMarkOmittable: false',
        '   * assert it against the real call rather than against this prose.\n   */\n  appendCanMarkOmittable: boolean'],
      ['      appendCanMarkOmittable: false,\n      seam,\n      verdict: \'safe\',', '      appendCanMarkOmittable: true,\n      seam,\n      verdict: \'safe\','],
    ],
  },
  {
    name: 'classify: the double-prefix trap is dropped from the advice',
    file: 'src/classify.ts',
    edits: [[
      "      'Do NOT prefix the type with `plugin:` yourself. The v3→v4 format migration adds that prefix to'\n"
      + "      + ' unknown omittable types, so pre-prefixing stores `plugin:plugin:<type>`.',\n",
      '',
    ]],
  },
  {
    name: 'classify: the seam is advised without naming how to reach it',
    file: 'src/classify.ts',
    edits: [[
      "      'To keep the event, write the envelope yourself through the public handle seam:'\n"
      + "      + ' ctx.sessionPersistence.open(id, \\'write\\') → handle.append([envelope]), with the envelope'\n"
      + "      + ' carrying `ignorable: true`. buildExternalEvent() in this package builds exactly that object.',\n",
      "      'To keep the event, write it in a way the reader can skip.',\n",
    ]],
  },
  {
    name: 'envelope: a declared type may be marked omittable',
    file: 'src/envelope.ts',
    edits: [[
      "  if (KNOWN_EVENT_TYPES.has(type)) {\n    throw new SessionEventGuardError(\n      'KNOWN_TYPE',",
      "  if (false as boolean) {\n    throw new SessionEventGuardError(\n      'KNOWN_TYPE',",
    ]],
  },
  {
    name: 'envelope: an already-prefixed type is stored double-prefixed',
    file: 'src/envelope.ts',
    edits: [["  if (type.startsWith('plugin:')) {", '  if (false as boolean) {']],
  },
  {
    name: 'envelope: the namespace is no longer required',
    file: 'src/envelope.ts',
    edits: [[
      "  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(type)) {",
      '  if (false as boolean) {',
    ]],
  },
  {
    name: 'envelope: a non-finite number is accepted as JSON',
    file: 'src/envelope.ts',
    edits: [["        if (!Number.isFinite(node)) return `${path} is a non-finite number`\n", '']],
  },
  {
    name: 'envelope: negative zero is accepted as JSON',
    file: 'src/envelope.ts',
    edits: [["        if (Object.is(node, -0)) return `${path} is negative zero`\n", '']],
  },
  {
    name: 'envelope: a cycle is walked again instead of refused',
    file: 'src/envelope.ts',
    edits: [["    if (seen.has(node)) return `${path} is a circular reference`\n", '']],
  },
  {
    name: 'envelope: a hole in a sparse array is walked as a value',
    file: 'src/envelope.ts',
    edits: [["        if (!Object.hasOwn(node, index)) return `${path}[${index}] is a hole in a sparse array`\n", '']],
  },
  {
    name: 'envelope: an exotic object is stored as a plain one',
    file: 'src/envelope.ts',
    edits: [[
      "    if (proto !== null && Object.getPrototypeOf(proto) !== null) {\n"
      + "      return `${path} is an exotic object (${(node as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'})`\n"
      + '    }\n',
      '',
    ]],
  },
  {
    name: 'envelope: a refusal that cannot locate itself names the wrong path',
    file: 'src/envelope.ts',
    edits: [["  const pending: { node: unknown; path: string }[] = [{ node: value, path: 'data' }]", "  const pending: { node: unknown; path: string }[] = [{ node: value, path: 'payload' }]"]],
  },
  {
    name: 'envelope: the creation time is not defaulted',
    file: 'src/envelope.ts',
    edits: [['time: input.at ?? Date.now()', 'time: input.at ?? 0']],
  },
  {
    // EQUIVALENT MUTANT, recorded rather than hidden. Copying the payload
    // through a JSON round trip is the identity on every value that reaches this
    // line, and that is provable rather than merely unobserved: `jsonDefect` has
    // already refused every value that a round trip would change (non-finite
    // numbers, negative zero, cycles, holes, exotic objects, functions,
    // undefined), so on the accepted domain the copy and the original are the
    // same JSON. Kept in the list because "we tried to make this arm bite and
    // could not, and here is why" is a fact about the code.
    name: 'envelope: the payload is copied through a JSON round trip',
    file: 'src/envelope.ts',
    equivalent: 'jsonDefect has already refused every value a JSON round trip would change, so the two are the same JSON on the accepted domain',
    edits: [[
      'return { type, seq: input.seq, time: input.at ?? Date.now(), data: input.data, ignorable: true }',
      'return { type, seq: input.seq, time: input.at ?? Date.now(), data: JSON.parse(JSON.stringify(input.data)), ignorable: true }',
    ]],
  },
  {
    name: 'audit: the marker is ignored when a stored event is judged',
    file: 'src/audit.ts',
    edits: [['standingOf(event.type, event.ignorable)', 'standingOf(event.type)']],
  },
  {
    name: 'audit: a refusal is reported as a generic read failure',
    file: 'src/audit.ts',
    edits: [[
      "  return error instanceof Error && /ignorable|unknown to this harness/i.test(error.message)\n    ? 'refused'\n    : 'unreadable'",
      "  return 'unreadable'",
    ]],
  },
  {
    name: 'audit: a session that does not exist is reported as a failure',
    file: 'src/audit.ts',
    edits: [["  if (error instanceof Error && /not found|ENOENT/i.test(`${error.name} ${error.message}`)) return 'missing'\n", '']],
  },
  {
    name: 'audit: a failure during enumeration is reported as a complete log',
    file: 'src/audit.ts',
    edits: [[
      "      ...empty,\n      truncated: true,\n      ...sizeBytes === undefined ? {} : { sizeBytes },",
      "      ...empty,\n      truncated: false,\n      ...sizeBytes === undefined ? {} : { sizeBytes },",
    ]],
  },
  {
    name: 'audit: a throw that is not an Error loses its message',
    file: 'src/audit.ts',
    edits: [["  return error instanceof Error ? error.message : String(error)", "  return error instanceof Error ? error.message : ''"]],
  },
  {
    name: 'audit: a throw that is not an Error is given an Error class name',
    file: 'src/audit.ts',
    edits: [["  return error instanceof Error ? error.name : typeof error", "  return 'Error'"]],
  },
  {
    name: 'audit: the store is swept oldest first',
    file: 'src/audit.ts',
    edits: [['(a, b) => b.header.createdAt - a.header.createdAt', '(a, b) => a.header.createdAt - b.header.createdAt']],
  },
  {
    name: 'report: a seam-required verdict is rendered as SAFE',
    file: 'src/report.ts',
    edits: [[
      "    verdict.verdict === 'safe'\n      ? 'Verdict: SAFE — this type is interpreted by every build of this line.'\n      : 'Verdict: SEAM-REQUIRED — written with session.append this type makes the session unreadable'\n        + ' to a reader that does not load the writing plugin.',",
      "    verdict.verdict === 'safe'\n      ? 'Verdict: SAFE — this type is interpreted by every build of this line.'\n      : 'Verdict: SAFE — this type is interpreted by every build of this line.',",
    ]],
  },
  {
    name: 'report: the two write paths are swapped in the report',
    file: 'src/report.ts',
    edits: [["    row('envelope from session.append', verdict.natural),", "    row('envelope from session.append', verdict.seam),"]],
  },
  {
    name: 'report: the append limitation is rendered as a capability',
    file: 'src/report.ts',
    edits: [["    row('append can set `ignorable`', String(verdict.appendCanMarkOmittable)),", "    row('append can set `ignorable`', 'true'),"]],
  },
  {
    name: 'report: a truncated enumeration is presented as the whole log',
    file: 'src/report.ts',
    edits: [['  if (audit.truncated) {', '  if (false) {']],
  },
  {
    name: 'report: the sessions that were not opened are not disclosed',
    file: 'src/report.ts',
    edits: [['  if (audits.length < total) {', '  if (false) {']],
  },
  {
    name: 'report: the two audit outcomes are swapped',
    file: 'src/report.ts',
    edits: [['  if (audit.loadable) {', '  if (audit.loadable !== true) {']],
  },
  {
    name: 'guard: a declared event is reported as an offence',
    file: 'src/index.ts',
    edits: [["    if (standing !== 'required') return", '    if (false) return']],
  },
  {
    name: 'guard: the first offending sequence is always reported as zero',
    file: 'src/index.ts',
    edits: [['offences.set(event.type, { type: event.type, firstSeq: event.seq, count: 1 })', 'offences.set(event.type, { type: event.type, firstSeq: 0, count: 1 })']],
  },
  {
    name: 'guard: a repeated offence is not counted',
    file: 'src/index.ts',
    edits: [['      existing.count += 1\n', '']],
  },
  {
    name: 'guard: one session may grow the ledger without bound',
    file: 'src/index.ts',
    edits: [['    if (offences.size >= LEDGER_LIMIT) return\n', '']],
  },
  {
    name: 'guard: the ledger keeps every session it has ever seen',
    file: 'src/index.ts',
    edits: [['      if (ledger.size >= LEDGER_SESSIONS) ledger.delete(ledger.keys().next().value as string)\n', '']],
  },
  {
    name: 'guard: a preflight alone is turned into a storage sweep',
    file: 'src/index.ts',
    edits: [['      const wantsStorage = args.session !== undefined || write === undefined', '      const wantsStorage = args.session !== undefined']],
  },
  {
    name: 'guard: the store limit ignores what the caller asked for',
    file: 'src/index.ts',
    edits: [['      const limit = Math.max(1, Math.min(args.limit ?? 20, 500))', '      const limit = 20']],
  },
  {
    name: 'guard: every audited session is named as refused',
    file: 'src/index.ts',
    edits: [['        refusedSessions: refused.map(audit => audit.id),', '        refusedSessions: audits.map(audit => audit.id),']],
  },
  {
    name: 'guard: a process with no backend is not told so',
    file: 'src/index.ts',
    edits: [['      if (wantsStorage && persistence === undefined) {', '      if (false) {']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: one arm removes the check that stops the
 * payload walk on a circular reference, and a mutant that does not terminate is
 * a mutant the suite cannot report on. It is killed here and counted as caught,
 * which is what it is — the suite never reaches its assertions because the code
 * under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = run('npx', ['tsc'])
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = run('node', ['--test', 'test/*.spec.mjs'])
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = run('npx', ['tsc'])
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
