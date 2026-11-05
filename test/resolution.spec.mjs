/**
 * The resolver's failure mode, measured rather than reasoned about.
 *
 * 0.3.1 made the plugin load in a profile by asking the running host for its own
 * modules. That answered "does it load", which is one arm. It did not answer
 * what happens when the asking fails, and the shape of that answer is not
 * obvious from reading the code, because there were two ways to get it wrong and
 * only one of them looks wrong:
 *
 * - **A silent fallback.** `require()` succeeds identically on the host's own
 *   module and on a second copy of it. Classifying against the copy's vocabulary
 *   produces a complete, confident, wrong answer — no error anywhere, which is
 *   why the report carries which evidence it had.
 * - **An outage wearing a verdict.** The write veto asks the resolver for the
 *   reader and then asks the reader about the payload. With both in one `catch`,
 *   a resolver outage becomes "the reader refused this event", with the
 *   resolver's own sentence as the reason — a fabricated refusal on every append.
 *
 * The arms below are the ones that decide it, and each is measured in a child
 * process, because the resolver caches and the shapes that decide this question
 * are process-level: the working directory, `process.argv[1]`, and whether a
 * host module is on the stack.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A directory under the OS temp root, namespaced to this suite.
 * @param tag - a short label for the shape.
 * @returns the path.
 */
function scratch(tag) {
  return mkdtempSync(join(tmpdir(), `seg-resolution-${tag}-`))
}

/**
 * A copy of the shipped `lib/`, in a directory whose parents hold no
 * `node_modules` — the layout a profile gives a plugin, and the one shape where
 * every anchor fails.
 * @param tag - a short label for the shape.
 * @returns the scratch root and the plugin's entry inside it.
 */
function packedCopy(tag) {
  const root = scratch(tag)
  cpSync(join(ROOT, 'lib'), join(root, 'plugin', 'lib'), { recursive: true })
  return { root, entry: join(root, 'plugin', 'lib', 'index.js') }
}

/**
 * Run one probe script in a child process and return what it printed.
 * @param script - the probe's source.
 * @param options - `cwd` for the child, and any extra file to write first.
 * @returns the parsed JSON the probe printed.
 */
function probe(script, options = {}) {
  const root = options.root ?? scratch('probe')
  const path = join(root, 'probe.mjs')
  writeFileSync(path, script)
  const stdout = execFileSync(process.execPath, [path], {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const line = stdout.trim().split('\n').filter(Boolean).at(-1)
  return JSON.parse(line)
}

test('in a development checkout the report says `fallback`, and names the tree it read', () => {
  // The package's own suite resolves through `import.meta.url`: the harness
  // packages here are devDependencies, and no host frame is on the stack. That
  // is a legitimate reading, and it must describe itself as the weaker one
  // rather than borrow the host's authority.
  const result = probe(`
    import { resolutionReport, resolutionCounts, vocabularyReport } from ${JSON.stringify(join(ROOT, 'lib', 'index.js'))}
    console.log(JSON.stringify({ report: resolutionReport(), vocabulary: vocabularyReport(), counts: resolutionCounts() }))
  `)
  assert.equal(result.report.reached, true)
  assert.equal(result.report.kind, 'fallback', 'a devDependency tree is not proof of the host instance')
  assert.ok(result.report.anchor.endsWith(join('lib', 'host.js')), `unexpected anchor ${result.report.anchor}`)
  // The vocabulary report and the resolution report must not disagree about the
  // same resolution: two spellings of one measurement is how a disclosure rots.
  assert.equal(result.vocabulary.kind, result.report.kind)
  assert.equal(result.vocabulary.anchor, result.report.anchor)
  assert.ok(result.vocabulary.size > 0, 'the fallback still answered a real vocabulary')
  assert.ok(result.counts.attempts >= 1)
  assert.equal(result.counts.failures, 0)
})

test('a host frame is recognised as the host, and reaches the host\u2019s own instance', () => {
  // A module *inside* the host install is the shape the plugin actually runs in:
  // the host calls in, so a `node_modules/@deepseek-ai/*` frame is on the stack.
  //
  // The layout is built rather than borrowed from this checkout, because this
  // checkout's own directory *is* the plugin: a frame under it is this package's
  // code or its devDependencies, which is precisely what the resolver must not
  // mistake for the host. So the host tree is a copy, and the probe lives inside
  // it — the same relationship a real install has.
  const root = scratch('host-frame')
  const hostModules = join(root, 'host', 'node_modules')
  mkdirSync(hostModules, { recursive: true })
  cpSync(join(ROOT, 'node_modules', '@deepseek-ai'), join(hostModules, '@deepseek-ai'), { recursive: true })
  // Everything else the harness packages import by bare specifier: linked rather
  // than copied, because they are not what this arm is about.
  for (const entry of readdirSync(join(ROOT, 'node_modules'))) {
    if (entry === '@deepseek-ai' || entry.startsWith('.')) continue
    symlinkSync(join(ROOT, 'node_modules', entry), join(hostModules, entry), 'dir')
  }
  cpSync(join(ROOT, 'lib'), join(root, 'plugin', 'lib'), { recursive: true })
  const entry = join(root, 'plugin', 'lib', 'index.js')
  const marker = join(hostModules, '@deepseek-ai', 'dsh-tools', '__emrg-resolution-probe.mjs')
  writeFileSync(marker, `
    import { createRequire } from 'node:module'
    import { resolutionReport, knownEventTypes, vocabularyReport } from ${JSON.stringify(entry)}
    const require = createRequire(import.meta.url)
    // Resolved from this frame, which sits inside the host install: this is the
    // namespace object the host itself would get.
    const session = require('@deepseek-ai/dsh-session')
    const report = resolutionReport()
    console.log(JSON.stringify({
      report,
      vocabulary: vocabularyReport(),
      sameNamespace: knownEventTypes() === session.KNOWN_SESSION_EVENT_TYPES,
      probePath: new URL(import.meta.url).pathname,
    }))
  `)
  try {
    const stdout = execFileSync(process.execPath, [marker], { encoding: 'utf8', cwd: root })
    const result = JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1))
    assert.equal(result.report.reached, true)
    assert.equal(result.report.kind, 'host-frame', `expected a host frame, got ${result.report.kind}`)
    assert.ok(result.report.anchor.includes(join('node_modules', '@deepseek-ai')), `unexpected anchor ${result.report.anchor}`)
    // The decisive reading: not "it loaded", but "it is the caller's own object".
    assert.equal(result.sameNamespace, true, 'the vocabulary must be the caller\u2019s own Set, by identity')
    assert.equal(result.vocabulary.kind, 'host-frame')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a second copy resolves just as happily \u2014 and is disclosed as `fallback`, not as the host', () => {
  // The disagreeing control. If resolution success were taken as proof of the
  // host instance, this arm would be indistinguishable from the one above: the
  // same call succeeds, returns a namespace, and describes a package by the same
  // name. Only the evidence field and the identity comparison separate them.
  const { root, entry } = packedCopy('copy')
  const fake = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(join(fake, 'dsh-session'), { recursive: true })
  mkdirSync(join(fake, 'dsh-tools'), { recursive: true })
  writeFileSync(join(fake, 'dsh-session', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '9.9.9', main: 'index.js' }))
  writeFileSync(join(fake, 'dsh-session', 'index.js'),
    'exports.KNOWN_SESSION_EVENT_TYPES = new Set(["decoy/only"])\n'
    + 'exports.adoptSessionEvent = value => value\n')
  writeFileSync(join(fake, 'dsh-tools', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '9.9.9', main: 'index.js' }))
  writeFileSync(join(fake, 'dsh-tools', 'index.js'), 'exports.defineTool = definition => definition\n')

  const result = probe(`
    import { resolutionReport, knownEventTypes, vocabularyReport } from ${JSON.stringify(entry)}
    console.log(JSON.stringify({
      report: resolutionReport(),
      vocabulary: vocabularyReport(),
      types: [...knownEventTypes()],
    }))
  `, { root, cwd: root })
  assert.equal(result.report.reached, true, 'a decoy copy is still a successful resolution')
  assert.equal(result.report.kind, 'fallback', 'and must never be reported as the host')
  assert.deepEqual(result.types, ['decoy/only'], 'the decoy answered, which is exactly the hazard')
  assert.equal(result.vocabulary.version, '9.9.9', 'the report names the build that answered, so a decoy is visible')
})

test('with nowhere to resolve, the report says inactive, counts the failure, and lists every anchor', () => {
  const { root, entry } = packedCopy('unreachable')
  const result = probe(`
    import { resolutionReport, resolutionCounts, resolutionReport as again } from ${JSON.stringify(entry)}
    const first = resolutionReport()
    const second = again()
    console.log(JSON.stringify({ first, second, counts: resolutionCounts() }))
  `, { root, cwd: root })
  assert.equal(result.first.reached, false)
  assert.equal(result.first.inactive, true, 'the state must name itself: inactive, not "loaded"')
  assert.ok(result.first.reached === false && result.first.tried.length >= 2, `expected anchors, saw ${JSON.stringify(result.first.tried)}`)
  assert.ok(result.first.tried.every(anchor => typeof anchor === 'string'))
  assert.match(result.first.reason, /inactive/)
  // Counted, not merely reported: one failure and then two, whichever call order
  // produced them, is what separates "could not reach once" from "cannot reach".
  assert.equal(result.first.failures, 1)
  assert.equal(result.second.failures, 2)
  assert.equal(result.counts.failures, 2)
  assert.equal(result.counts.attempts, 2)
})

test('an unreachable host is never reported as the reader refusing the payload', () => {
  // The defect this arm exists for: `refusalFor` asks the resolver for the reader
  // and the reader about the payload. With both inside one `catch`, an outage
  // produced a refusal, with the resolver's message as the reason, for every
  // append — a verdict about a payload that was never judged.
  const { root, entry } = packedCopy('no-false-refusal')
  const result = probe(`
    import { refusalFor } from ${JSON.stringify(join(root, 'plugin', 'lib', 'veto.js'))}
    console.log(JSON.stringify({
      refusal: refusalFor('filesnap/point', { value: 'x' }, undefined) ?? null,
      entry: ${JSON.stringify(entry)},
    }))
  `, { root, cwd: root })
  assert.equal(result.refusal, null, 'no reader was obtained, so there is no verdict to give')
})

test('mounting an unreachable host reports at error level and installs nothing', () => {
  // `apply` is the one place an outage can be reported while the process is
  // still running. It must reach the operator (an error-level line naming every
  // anchor) and it must not half-mount: a plugin that registered a tool and a
  // veto with no reader behind them is the state that produces false refusals.
  const { root, entry } = packedCopy('mount')
  const result = probe(`
    import { apply } from ${JSON.stringify(entry)}
    const logged = []
    let interactions = 0
    const ctx = {
      logger: {
        error: (message, ...rest) => logged.push(['error', String(message), ...rest.map(String)]),
        warn: (message, ...rest) => logged.push(['warn', String(message), ...rest.map(String)]),
        debug: (message, ...rest) => logged.push(['debug', String(message), ...rest.map(String)]),
      },
      effect: () => { interactions += 1 },
      on: () => { interactions += 1 },
      tools: { register: () => { interactions += 1 } },
      inject: () => { interactions += 1 },
      get: () => undefined,
    }
    apply(ctx)
    console.log(JSON.stringify({ logged, interactions }))
  `, { root, cwd: root })
  const errors = result.logged.filter(([level]) => level === 'error')
  assert.equal(errors.length, 1, 'the outage is reported exactly once, at error level')
  assert.match(errors[0][1], /inactive/)
  assert.match(errors[0][1], /Tried:/, 'the report must name the anchors it tried')
  assert.equal(result.interactions, 0, 'nothing is mounted: no veto, no tool, no lifecycle hook')
})
