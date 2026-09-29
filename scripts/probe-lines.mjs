#!/usr/bin/env node
/**
 * A `peerDependencies` range is a claim about versions nobody ran. This script
 * makes the claim checkable instead of asserted: for each line the range admits,
 * it copies this package into a scratch directory, pins every harness package to
 * that line, installs, builds, and runs the suite.
 *
 * The lines come from the manifest, not from a list here — a probe with its own
 * copy of the contract can drift from the thing it is supposed to be checking.
 * Each `||` segment of the range is one line, and its **newest** published build
 * is the representative: the earliest build of a line is an alpha nobody is left
 * on, and probing it says less than probing the build the line converged to.
 *
 * ```sh
 * npm run test:probe-lines                 # every line the range admits
 * npm run test:probe-lines -- 0.2.0-rc.2   # one line
 * npm run test:probe-lines -- --keep       # leave the scratch trees in place
 * ```
 *
 * A line that fails here is removed from the range (manifest, README and the
 * `SUPPORTED_LINES` contract in `test/packaging.spec.mjs`) rather than left
 * claimed. This script is development-only and is not published.
 *
 * @module scripts/probe-lines
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** What is copied into the scratch tree; everything else is not needed to test. */
const COPIED = ['src', 'test', 'tsconfig.json', 'README.md', 'LICENSE', 'cordis.patch.yml']

/**
 * The harness packages pinned to the probed line.
 *
 * `@deepseek-ai/dsh-scope` is here because it is a **transitive requirement the
 * published metadata does not declare**: `dsh-session`'s build imports it and
 * nothing in its `package.json` asks for it, so a tree that installs only the
 * declared graph cannot load `dsh-session` at all. A real deployment gets it
 * from the profile's own lockfile. `@deepseek-ai/cordis` is deliberately NOT
 * here: its versions do not follow the harness's line numbering, so it stays at
 * whatever the manifest's `devDependencies` already pin.
 */
const HARNESS = [
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-format-v3-to-v4',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
]

/**
 * The newest published build of each `||` segment of a range.
 * @param range - a semver range, composed of `||` segments.
 * @param versions - every published version of the package.
 * @returns one version per segment, in range order.
 */
function representativesOf(range, versions) {
  return range.split('||')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0)
    .map(segment => semver.maxSatisfying(versions, segment))
}

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const requested = argv.filter(argument => !argument.startsWith('-'))

const range = manifest.peerDependencies['@deepseek-ai/dsh-session']
const published = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh-session', 'versions', '--json'], { encoding: 'utf8' }))
const lines = requested.length > 0 ? requested : representativesOf(range, published)

/**
 * Install the probed line, and say so when npm's own resolution had to be
 * overruled.
 *
 * The harness packages peer-depend on each other and on a `@deepseek-ai/cordis`
 * floor that moves between lines, which npm refuses to resolve into one tree
 * when the manifest's own cordis pin is lower. That refusal is a fact about the
 * harness's published metadata, not about this plugin — a real install gets
 * these packages from the profile's lockfile — so the probe retries with
 * `--force` and records that the line's tree is npm's own choice.
 * @param dir - the probe tree.
 * @param log - the progress writer.
 * @param line - the line being probed.
 */
function install(dir, log, line) {
  const options = { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], options)
  } catch {
    log(`    npm refused the ${line} peer graph; retrying with --force`)
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--force'], options)
  }
}

/** Install one probe and run the suite in it. */
function probe(line) {
  const dir = mkdtempSync(join(tmpdir(), `session-event-guard-${line}-`))
  const log = message => process.stdout.write(`${message}\n`)
  log(`\n=== ${line} — ${dir}`)
  for (const entry of COPIED) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    ...manifest,
    // The published version is the thing under test in `packedPaths()`; nothing
    // else about the manifest changes, so the packaging arms still apply.
    devDependencies: {
      ...manifest.devDependencies,
      ...Object.fromEntries(HARNESS.map(name => [name, line])),
    },
    // No `test:probe-lines` here: the probe must not be able to recurse.
    scripts: { build: 'tsc', test: 'tsc && node --test "test/*.spec.mjs"' },
  }, null, 2)}\n`)
  try {
    install(dir, log, line)
    execFileSync('npm', ['test'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] })
    log(`=== ${line}: PASS`)
    return true
  } catch (error) {
    if (error.stdout !== undefined) process.stdout.write(String(error.stdout))
    log(`=== ${line}: FAIL`)
    return false
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true })
  }
}

const failed = lines.filter(line => !probe(line))
process.stdout.write(`\nprobed ${lines.length} line(s) of ${range}\n`)
if (failed.length > 0) {
  process.stdout.write(`failed: ${failed.join(', ')} — remove them from the range, the README and SUPPORTED_LINES\n`)
  process.exitCode = 1
}
