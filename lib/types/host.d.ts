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
/** The host packages this plugin borrows. Both are declaration-time peers. */
export declare const HOST_PACKAGES: readonly ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-tools"];
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
export type ResolutionKind = 'host-frame' | 'fallback';
/** One base path to try, and what resolving through it would prove. */
export interface AnchorCandidate {
    /** The file path to resolve from. */
    path: string;
    /** The evidence a success through this anchor carries. */
    kind: ResolutionKind;
}
/** One borrowed module set, plus where it was found. */
export interface HostModules {
    /** The path whose resolution answered, for disclosure in a report. */
    anchor: string;
    /** Whether that anchor proves the instance is the host's own. */
    kind: ResolutionKind;
    /** `@deepseek-ai/dsh-session`'s own adoption path and generated vocabulary. */
    session: {
        /** The exported validator the write path never calls. */
        adoptSessionEvent: typeof import('@deepseek-ai/dsh-session').adoptSessionEvent;
        /** Every event type this build declares. */
        knownTypes: ReadonlySet<string>;
        /** The version of the build that answered. */
        version: string;
    };
    /** `@deepseek-ai/dsh-tools`' definition builder, so a tool is registered as the host builds one. */
    defineTool: typeof import('@deepseek-ai/dsh-tools').defineTool;
}
/** A resolution that answered, and what it is evidence of. */
export interface ResolutionReached {
    /** The discriminant a caller branches on. */
    reached: true;
    /** Whether the instance is provably the host's own. */
    kind: ResolutionKind;
    /** The path whose resolution answered. */
    anchor: string;
    /** The version of every host package that answered, by name. */
    packages: Readonly<Record<string, string>>;
    /** Failures recorded so far in this process, this one included when it applies. */
    failures: number;
}
/** A resolution that did not answer. The guard is inactive, and says so. */
export interface ResolutionUnreached {
    /** The discriminant a caller branches on. */
    reached: false;
    /** Constant marker: no host module was reached, so nothing is guarded. */
    inactive: true;
    /** Every base path that was tried, in order. */
    tried: readonly string[];
    /** How many resolution attempts have failed in this process. */
    failures: number;
    /** What this state means, in one sentence an operator can act on. */
    reason: string;
}
/** What {@link resolutionReport} answers. */
export type ResolutionReport = ResolutionReached | ResolutionUnreached;
/** Raised when no anchor resolves the host packages. Never a silent fallback. */
export declare class HostResolutionError extends Error {
    /** Every base path that was tried, in order. */
    readonly anchors: readonly string[];
    constructor(anchors: readonly string[]);
}
/**
 * How many resolutions have been attempted, and how many found nothing.
 *
 * A count rather than the last value: a guard that could not reach the host
 * once and a guard that has been failing on every append all cycle are
 * different operational states, and only the count separates them.
 * @returns the running totals for this process.
 */
export declare function resolutionCounts(): {
    attempts: number;
    failures: number;
};
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
export declare function resolutionReport(): ResolutionReport;
/**
 * The host's modules, resolved once and reused.
 *
 * The first call resolves and caches; a failure is not cached, so a later call
 * from a deeper host frame gets its own chance to find an anchor.
 * @returns the borrowed modules and the anchor that answered.
 * @throws {HostResolutionError} when no anchor resolves the packages.
 */
export declare function hostModules(): HostModules;
//# sourceMappingURL=host.d.ts.map