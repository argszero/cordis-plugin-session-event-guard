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

/** One borrowed module set, plus where it was found. */
export interface HostModules {
  /** The path whose resolution answered, for disclosure in a report. */
  anchor: string
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
 * @returns candidate base paths, outermost frame first.
 */
function stackAnchors(): string[] {
  const stack = String(new Error('anchor').stack ?? '')
  const found: string[] = []
  for (const line of stack.split('\n')) {
    const match = line.match(/\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/)
    const frame = match?.[1]
    if (frame === undefined) continue
    const path = frame.startsWith('file://') ? fileURLToPath(frame) : frame
    if (!path.includes(`${join('node_modules', '@deepseek-ai')}`)) continue
    if (path.includes('session-event-guard')) continue
    if (!found.includes(path)) found.push(path)
  }
  return found
}

/**
 * Every anchor to try, in the order that prefers the host over this package.
 * @returns base file paths, de-duplicated.
 */
function anchors(): string[] {
  const candidates = [
    ...stackAnchors(),
    process.argv[1] === undefined ? undefined : process.argv[1],
    join(process.cwd(), 'index.js'),
    fileURLToPath(import.meta.url),
  ]
  return [...new Set(candidates.filter((path): path is string => typeof path === 'string'))]
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

let cached: HostModules | undefined

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
  const tried: string[] = []
  for (const anchor of anchors()) {
    tried.push(anchor)
    try {
      const require = createRequire(anchor)
      // `require()` of an ES module returns the namespace object the host
      // already loaded: the same object, not a copy of it.
      const session = require('@deepseek-ai/dsh-session') as typeof import('@deepseek-ai/dsh-session')
      const tools = require('@deepseek-ai/dsh-tools') as typeof import('@deepseek-ai/dsh-tools')
      cached = {
        anchor,
        session: {
          adoptSessionEvent: session.adoptSessionEvent,
          knownTypes: session.KNOWN_SESSION_EVENT_TYPES,
          version: versionOf(require, '@deepseek-ai/dsh-session'),
        },
        defineTool: tools.defineTool,
      }
      return cached
    } catch {
      // This anchor is a candidate, not a verdict: the next one may resolve.
      continue
    }
  }
  throw new HostResolutionError(tried)
}
