/**
 * The harness modules this plugin borrows, resolved from the running host.
 *
 * Three measurements decide this module's shape, and each one closed a door.
 *
 * **The borrowed values carry no identity across a boundary.** `defineTool`
 * returns a plain `ToolDefinition` object literal
 * (`packages/core/tools/src/schema.ts`), `KNOWN_SESSION_EVENT_TYPES` is a
 * `ReadonlySet<string>` of type names, and `adoptSessionEvent` validates
 * structurally and hands back the same object. Nothing here is a brand, a
 * `WeakSet` membership or an `instanceof` that a second copy would break, so a
 * cross-boundary identity was never the obstacle.
 *
 * **Declaring the packages as `dependencies` is not the repair.** A profile
 * installs with `autoInstallPeers: false` (`pnpm-workspace.yaml`), so pnpm
 * installs a package's own `dependencies` and none of its peers.
 * `@deepseek-ai/dsh-session`'s entry imports `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-scope` and `@deepseek-ai/dsh-llm` at module scope — all of
 * them peers of that package — and `@deepseek-ai/dsh-tools` additionally needs
 * `@deepseek-ai/dsh-sandbox`. Declared as a dependency, either package
 * therefore fails one level deeper than the import it was meant to fix. And
 * even where it loaded, it would be the shape discussion #10338 reports: a
 * plugin that pins `@deepseek-ai/dsh-tools` as a runtime dependency silently
 * overwrites the host's own core packages, and the next start does not boot.
 *
 * **The host hands over its own copy.** Node resolves a bare specifier from a
 * base path, and `require()` of an ES module returns the namespace object the
 * host already loaded — the same object, not a second one (measured: the
 * `adoptSessionEvent` and `KNOWN_SESSION_EVENT_TYPES` identities compare equal
 * to the host's). So the anchor is a path the host itself produced: the module
 * a host frame lives in, read from a stack trace at the moment of use. When the
 * plugin is called by the host — which is every time it matters, from a cordis
 * activation to a tool execution, to a shadowed `append` — such a frame is
 * always on the stack. The running application's entry (`process.argv[1]`),
 * the working directory, and finally this package's own tree are the fallbacks,
 * which is what a development checkout and this package's own suite use.
 *
 * ## Reaching *a* module is not reaching the host's module
 *
 * The third measurement is a claim about a *successful* resolution, and success
 * is not by itself evidence for it. A fallback anchor can resolve a different
 * copy of the same package — a nested `node_modules`, a second profile, a stale
 * tree beside the working directory — and `require()` answers identically in
 * every one of those cases. Only a `host-frame` anchor proves the instance is
 * the host's own, because that frame exists only while the host is the caller.
 *
 * So a resolution reports which of the two it is ({@link ResolutionKind}), and
 * the two are not interchangeable: `host-frame` is the shipped answer, and
 * `fallback` is disclosed rather than assumed. Two failure modes follow, and
 * this module refuses both:
 *
 * - **A silent fallback.** Classifying against a fallback copy's vocabulary
 *   would answer about a build the reader may not be running. The report names
 *   the evidence so the caller can tell.
 * - **A resolution failure wearing a verdict.** {@link resolutionReport} never
 *   throws and never answers "accepted": it says `reached: false`, lists every
 *   anchor it tried, and counts the failure. Nothing downstream may convert it
 *   into a judgement about a payload — the write veto asks the resolver to
 *   *obtain* the reader, and cannot report a missing reader as the reader's own
 *   refusal.
 *
 * Resolution is synchronous because the write veto is: it runs inside the
 * shadowed `append`, which cannot await. It is also lazy — nothing here runs at
 * import time, which is what lets the package load in a profile that installs
 * none of the harness packages.
 *
 * @module @argszero/cordis-plugin-session-event-guard/host
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The host packages this plugin borrows. Both are declaration-time peers. */
export const HOST_PACKAGES = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools'] as const

/**
 * This package's own directory.
 *
 * A frame inside it is never the host's: it is this plugin's code, or a copy of
 * the harness packages installed beneath it as devDependencies. Matched by path
 * prefix rather than by name, because a name match is wrong in both directions —
 * it would miss a package installed under any other directory name, and it
 * silently discarded every frame whenever this package's own checkout happened
 * to be named `cordis-plugin-session-event-guard`, which is what this package's
 * repository is called.
 */
const SELF_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * What a successful resolution is evidence *of*.
 *
 * - `host-frame`: the base path was a `node_modules/@deepseek-ai/*` file on the
 *   stack, so the host is the caller and the module is the host's own.
 * - `fallback`: the base path was the process entry, the working directory or
 *   this package's own tree. The module may be the host's, or may be a second
 *   copy that happens to resolve; the plugin cannot tell from here, so it
 *   reports which it is instead of assuming.
 */
export type ResolutionKind = 'host-frame' | 'fallback'

/** One base path to try, and what resolving through it would prove. */
export interface AnchorCandidate {
  /** The file path to resolve from. */
  path: string
  /** The evidence a success through this anchor carries. */
  kind: ResolutionKind
}

/** One borrowed module set, plus where it was found. */
export interface HostModules {
  /** The path whose resolution answered, for disclosure in a report. */
  anchor: string
  /** Whether that anchor proves the instance is the host's own. */
  kind: ResolutionKind
  /** `@deepseek-ai/dsh-session`'s own adoption path and generated vocabulary. */
  session: {
    /** The exported validator the write path never calls. */
    adoptSessionEvent: typeof import('@deepseek-ai/dsh-session').adoptSessionEvent
    /** Every event type this build declares. */
    knownTypes: ReadonlySet<string>
    /** The version of the build that answered. */
    version: string
  }
  /** `@deepseek-ai/dsh-tools`' definition builder, so a tool is registered as the host builds one. */
  defineTool: typeof import('@deepseek-ai/dsh-tools').defineTool
}

/** A resolution that answered, and what it is evidence of. */
export interface ResolutionReached {
  /** The discriminant a caller branches on. */
  reached: true
  /** Whether the instance is provably the host's own. */
  kind: ResolutionKind
  /** The path whose resolution answered. */
  anchor: string
  /** The version of every host package that answered, by name. */
  packages: Readonly<Record<string, string>>
  /** Failures recorded so far in this process, this one included when it applies. */
  failures: number
}

/** A resolution that did not answer. The guard is inactive, and says so. */
export interface ResolutionUnreached {
  /** The discriminant a caller branches on. */
  reached: false
  /** Constant marker: no host module was reached, so nothing is guarded. */
  inactive: true
  /** Every base path that was tried, in order. */
  tried: readonly string[]
  /** How many resolution attempts have failed in this process. */
  failures: number
  /** What this state means, in one sentence an operator can act on. */
  reason: string
}

/** What {@link resolutionReport} answers. */
export type ResolutionReport = ResolutionReached | ResolutionUnreached

/** Raised when no anchor resolves the host packages. Never a silent fallback. */
export class HostResolutionError extends Error {
  /** Every base path that was tried, in order. */
  readonly anchors: readonly string[]
  constructor(anchors: readonly string[]) {
    super(
      'session-event-guard: could not reach the running host\'s '
      + `${HOST_PACKAGES.join(' and ')} from any anchor. Tried:\n`
      + anchors.map(anchor => `  - ${anchor}`).join('\n')
      + '\nThe guard refuses to run rather than load and veto nothing: without the host\'s own'
      + ' adoptSessionEvent it cannot tell a payload the reader refuses from one it accepts,'
      + ' and a guard that answers "accepted" for every event while reporting nothing is worse'
      + ' than one that does not load.',
    )
    this.name = 'HostResolutionError'
    this.anchors = anchors
  }
}

/**
 * File paths named by the current stack that belong to a host install.
 *
 * A frame is only useful as an anchor, so the search takes `node_modules`
 * package files and ignores this package's own frames — resolving from a
 * sibling of the plugin is exactly the resolution that fails in a profile.
 * Every candidate found here is `host-frame` evidence: such a frame exists only
 * because the host is the caller.
 * @returns candidate anchors, outermost frame first.
 */
function stackAnchors(): AnchorCandidate[] {
  const stack = String(new Error('anchor').stack ?? '')
  const found: AnchorCandidate[] = []
  for (const line of stack.split('\n')) {
    const match = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/)
    const frame = match?.[1]
    if (frame === undefined) continue
    const path = frame.startsWith('file://') ? fileURLToPath(frame) : frame
    if (!path.includes(`${join('node_modules', '@deepseek-ai')}`)) continue
    if (path.startsWith(SELF_ROOT)) continue
    if (!found.some(candidate => candidate.path === path)) found.push({ path, kind: 'host-frame' })
  }
  return found
}

/**
 * Every anchor to try, in the order that prefers the host over this package.
 *
 * De-duplication keeps the first occurrence, which is why the stack anchors come
 * first: the same path reached as a host frame and as a fallback is host-frame
 * evidence, and the weaker reading must not overwrite the stronger one.
 * @returns base file paths, de-duplicated, each with the evidence it carries.
 */
function anchorCandidates(): AnchorCandidate[] {
  const candidates: Array<AnchorCandidate | undefined> = [
    ...stackAnchors(),
    process.argv[1] === undefined ? undefined : { path: process.argv[1], kind: 'fallback' as const },
    { path: join(process.cwd(), 'index.js'), kind: 'fallback' as const },
    { path: fileURLToPath(import.meta.url), kind: 'fallback' as const },
  ]
  const seen = new Set<string>()
  const ordered: AnchorCandidate[] = []
  for (const candidate of candidates) {
    if (candidate === undefined || seen.has(candidate.path)) continue
    seen.add(candidate.path)
    ordered.push(candidate)
  }
  return ordered
}

/** Read one package's version through the same anchor that resolved it. */
function versionOf(require: NodeRequire, name: string): string {
  try {
    const manifest = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : 'unknown'
  } catch {
    const directory = dirname(require.resolve(name))
    try {
      const manifest = JSON.parse(readFileSync(join(directory, '..', 'package.json'), 'utf8')) as { version?: unknown }
      return typeof manifest.version === 'string' ? manifest.version : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

/** Resolve both host packages through one anchor, or throw. */
function readFrom(candidate: AnchorCandidate): HostModules {
  const require = createRequire(candidate.path)
  // `require()` of an ES module returns the namespace object the host already
  // loaded: the same object, not a copy of it.
  const session = require('@deepseek-ai/dsh-session') as typeof import('@deepseek-ai/dsh-session')
  const tools = require('@deepseek-ai/dsh-tools') as typeof import('@deepseek-ai/dsh-tools')
  return {
    anchor: candidate.path,
    kind: candidate.kind,
    session: {
      adoptSessionEvent: session.adoptSessionEvent,
      knownTypes: session.KNOWN_SESSION_EVENT_TYPES,
      version: versionOf(require, '@deepseek-ai/dsh-session'),
    },
    defineTool: tools.defineTool,
  }
}

let cached: HostModules | undefined

/** Running totals for this process: attempts made, and attempts that reached nothing. */
const counts = { attempts: 0, failures: 0 }

/**
 * How many resolutions have been attempted, and how many found nothing.
 *
 * A count rather than the last value: a guard that could not reach the host
 * once and a guard that has been failing on every append all cycle are
 * different operational states, and only the count separates them.
 * @returns the running totals for this process.
 */
export function resolutionCounts(): { attempts: number, failures: number } {
  return { attempts: counts.attempts, failures: counts.failures }
}

/**
 * What the resolver can currently reach, without ever throwing.
 *
 * This is the reading an operator needs when the guard looks inert: a resolution
 * that did not answer is `reached: false` with every anchor tried and a failure
 * counted, never an exception at the append site and never a verdict about the
 * caller's payload. It caches like {@link hostModules}, so calling it first is
 * also what makes a failed mount diagnosable afterwards.
 * @returns the reached modules with their evidence, or the anchors that failed.
 */
export function resolutionReport(): ResolutionReport {
  counts.attempts += 1
  const tried: string[] = []
  for (const candidate of anchorCandidates()) {
    tried.push(candidate.path)
    try {
      const modules = readFrom(candidate)
      cached = modules
      return {
        reached: true,
        kind: modules.kind,
        anchor: modules.anchor,
        packages: { [HOST_PACKAGES[0]]: modules.session.version },
        failures: counts.failures,
      }
    } catch {
      // This anchor is a candidate, not a verdict: the next one may resolve.
      continue
    }
  }
  if (cached !== undefined) {
    // Every anchor has since stopped resolving, but the cache still holds the
    // host's own modules: the report states what was reached, not what is
    // reachable right now.
    return {
      reached: true,
      kind: cached.kind,
      anchor: cached.anchor,
      packages: { [HOST_PACKAGES[0]]: cached.session.version },
      failures: counts.failures,
    }
  }
  counts.failures += 1
  return {
    reached: false,
    inactive: true,
    tried,
    failures: counts.failures,
    reason:
      'session-event-guard: no anchor reached the running host, so the guard is inactive —'
      + ' nothing is vetoed and no event type is classified. This is reported rather than'
      + ' swallowed because a guard that loads and guards nothing is worse than one that fails:'
      + ' an operator can act on an error, and cannot act on silence.',
  }
}

/**
 * The host's modules, resolved once and reused.
 *
 * The first call resolves and caches; a failure is not cached, so a later call
 * from a deeper host frame gets its own chance to find an anchor.
 * @returns the borrowed modules and the anchor that answered.
 * @throws {HostResolutionError} when no anchor resolves the packages.
 */
export function hostModules(): HostModules {
  if (cached !== undefined) return cached
  counts.attempts += 1
  const tried: string[] = []
  for (const candidate of anchorCandidates()) {
    tried.push(candidate.path)
    try {
      const modules = readFrom(candidate)
      cached = modules
      return modules
    } catch {
      continue
    }
  }
  counts.failures += 1
  throw new HostResolutionError(tried)
}
