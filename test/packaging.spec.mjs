/**
 * Packaging guard: the published artifact must declare every bare specifier it
 * imports, must not declare packages it never imports, must actually ship the
 * files the manifest promises — and must describe its own compatibility range
 * the same way in the manifest and in the README.
 *
 * Every arm here is a defect this family has already shipped once:
 *
 * - A value import declared only in `devDependencies` resolves on the publishing
 *   machine and fails for a consumer with `ERR_MODULE_NOT_FOUND`.
 * - A `files` list that names the entry but not its modules publishes a package
 *   whose own relative imports are missing — reachability probes stay green
 *   while the artifact is wrong, so the check asks npm itself what the tarball
 *   will contain and then walks every relative import inside it.
 * - A peer range is a claim about versions nobody ran. It has twice been written
 *   too long (admitting lines where an imported symbol does not exist) and twice
 *   been quoted only partially in a README, which turns the documentation into
 *   the trap. Both halves are asserted against one list of supported lines.
 *
 * `npm pack --dry-run` is deliberate: it uses npm's own matcher, where a
 * hand-rolled glob would be the same guess the defect is made of.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import semver from 'semver'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/**
 * The prerelease lines this plugin claims to work on.
 *
 * The floors of the range's `||` segments, plus the newest published build of
 * the lines the suite was actually run on. `0.2.0-rc.2` is here because the
 * 0.2.0 segment is the one a reader is most likely to assume is covered: the
 * emitted set and the storage contract are both read through it.
 * Adding a line here without running the suite on it is how a wrong range gets
 * published, so the list is the contract, not the manifest — every entry was
 * probed (`npm run test:probe-lines`) for the version that claims it.
 */
const SUPPORTED_LINES = ['0.1.7-alpha.1', '0.1.7-rc.2', '0.2.0-rc.2']

/** Every file under `dir` whose name ends with one of `extensions`. */
function walk(dir, extensions, found = []) {
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, extensions, found)
    else if (extensions.some(extension => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Specifiers reached by static import/export, dynamic `import()`, and `require()`. */
function allSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /(?:^|[\s;{])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;(=])(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|[\s;{])import\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  return [...specifiers]
}

/** Bare (installable) specifiers only: relative targets and `node:` builtins are not packages. */
function bareSpecifiers(source) {
  return allSpecifiers(source).filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:'))
}

/** The package a specifier resolves to: `@scope/name` or `name`, subpath dropped. */
function packageOf(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

const runtimeDeclared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
])

/** The harness packages whose API this plugin is compiled against. */
const dshPeers = Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))

const sourceFiles = [...walk(join(ROOT, 'src'), ['.ts']), ...walk(join(ROOT, 'lib'), ['.js'])]
const imported = new Set()
for (const file of sourceFiles) {
  for (const specifier of bareSpecifiers(readFileSync(file, 'utf8'))) imported.add(packageOf(specifier))
}

/** What npm itself would put in the tarball. */
function packedPaths() {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' })
  const parsed = JSON.parse(output)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return new Set(entry.files.map(file => file.path))
}

test('the guard has something to guard', () => {
  // A walk that silently finds nothing would make every assertion below vacuous.
  const relative = sourceFiles.flatMap(file => allSpecifiers(readFileSync(file, 'utf8')).filter(specifier => specifier.startsWith('.')))
  assert.ok(sourceFiles.some(file => file.endsWith(join('src', 'index.ts'))), 'src/index.ts must be scanned')
  assert.ok(sourceFiles.some(file => file.endsWith(join('lib', 'index.js'))), 'lib/index.js must be built and scanned')
  assert.ok(imported.size >= 1, `expected at least one bare import, saw ${imported.size}`)
  assert.ok(relative.length >= 4, `expected the entry to import its own modules, saw ${relative.length} relative specifiers`)
})

test('every bare import in the published artifact is a runtime dependency', () => {
  const undeclared = [...imported].filter(name => !runtimeDeclared.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `imported by shipped code but declared only in devDependencies (or nowhere): ${undeclared.join(', ')}`
      + ' — a consumer installing this package by name gets ERR_MODULE_NOT_FOUND',
  )
})

test('no runtime dependency is declared without being imported', () => {
  const unused = [...runtimeDeclared].filter(name => !imported.has(name))
  assert.deepEqual(unused, [], `declared but never imported by shipped code: ${unused.join(', ')}`)
})

test('every harness peer range admits exactly the lines this plugin claims, and no next minor', () => {
  // All three are a claim about versions this plugin was run against: the
  // vocabulary constant and the storage contract come from two of them, and the
  // tool definition is imported for value from the third.
  assert.ok(dshPeers.length >= 3, `expected the harness peers to be declared, saw ${dshPeers.join(', ')}`)
  for (const name of dshPeers) {
    const range = manifest.peerDependencies[name]
    assert.ok(typeof range === 'string' && range.length > 0, `${name} must carry a range`)
    for (const line of SUPPORTED_LINES) {
      assert.ok(semver.satisfies(line, range), `the peer range for ${name} rejects ${line}, which the README claims`)
    }
    assert.ok(!semver.satisfies('0.2.0', range), `the peer range for ${name} must not admit the next minor line`)
  }
})

test('the README quotes the range it is describing, in full', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // A README that quotes only the first `||` segment is a trap: it admits one
  // line where the published range admits six.
  for (const name of dshPeers) {
    assert.ok(readme.includes(manifest.peerDependencies[name]), `the README must quote the ${name} range verbatim`)
  }
  for (const line of ['0.1.7', '0.2.0']) {
    assert.ok(readme.includes(line), `the README must name the ${line} line it was verified against`)
  }
})

test('the tarball carries the entry, its modules, the bundle patch, and the type declarations', () => {
  const paths = packedPaths()
  for (const required of [
    'package.json',
    'lib/index.js', 'lib/vocabulary.js', 'lib/classify.js', 'lib/envelope.js', 'lib/audit.js', 'lib/report.js',
    'lib/types/index.d.ts', 'lib/types/vocabulary.d.ts', 'lib/types/classify.d.ts',
    'lib/types/envelope.d.ts', 'lib/types/audit.d.ts', 'lib/types/report.d.ts',
    'cordis.patch.yml', 'README.md', 'LICENSE',
  ]) {
    assert.ok(paths.has(required), `npm pack omits ${required} (declared in "files"): ${[...paths].join(', ')}`)
  }
  assert.ok(![...paths].some(path => path.startsWith('test/') || path.startsWith('src/') || path.startsWith('scripts/')), 'source, tests and scripts stay unpublished')
})

test('every manifest entry point is in the tarball, and the patch names this plugin', () => {
  const paths = packedPaths()
  assert.ok(paths.has(manifest.main), `"main" (${manifest.main}) is not in the tarball`)
  assert.ok(paths.has(manifest.types), `"types" (${manifest.types}) is not in the tarball`)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml', 'the bundle patch declaration points at the shipped file')
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.ok(patch.includes(manifest.name), 'the bundle patch must mount this package by name')
  assert.ok(patch.includes('session-event-guard'), 'the bundle patch must use this plugin\'s id')
})

test('every relative import inside the tarball resolves to a file the tarball contains', () => {
  const paths = packedPaths()
  let checked = 0
  for (const file of [...paths].filter(path => path.startsWith('lib/') && path.endsWith('.js'))) {
    for (const specifier of allSpecifiers(readFileSync(join(ROOT, file), 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      checked += 1
      const target = resolve(ROOT, dirname(file), specifier)
      const candidates = [target, `${target}.js`, join(target, 'index.js')]
      assert.ok(
        candidates.some(candidate => paths.has(resolve(candidate).slice(ROOT.length + 1))),
        `${file} imports ${specifier}, which the tarball does not contain`,
      )
    }
  }
  // The entry imports five of its own modules; a walk that found fewer than that
  // would be checking a different artifact than the one being published.
  assert.ok(checked >= 5, `expected to check the entry's own modules, checked ${checked}`)
})

test('the published version is the one the README documents', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes(`@argszero/cordis-plugin-session-event-guard@${manifest.version}`), 'the README must name the published version')
})
