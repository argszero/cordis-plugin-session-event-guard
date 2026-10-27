/**
 * The envelope an external plugin may write to a session log.
 *
 * The natural call cannot produce this object. `Session.append` freezes
 * `{ type, seq, time, data, ...surfaceMetadata }` itself and offers no way to
 * set the marker, so a session log can only carry an *omittable* external
 * event if the writer builds the envelope and hands it to the handle seam
 * (`ctx.sessionPersistence.open(id, 'write')` → `handle.append([event])`).
 *
 * This module builds that object and refuses the three mistakes a hand-rolled
 * one makes. Each refusal is a refusal at the write boundary, which is the
 * point: the alternative is a log that reads back fine in this process and is
 * refused by the next one.
 *
 * @module @argszero/cordis-plugin-session-event-guard/envelope
 */
/** A refusal this package raises before a bad event can reach storage. */
export declare class SessionEventGuardError extends Error {
    /** Stable machine-routable code. */
    readonly code: 'KNOWN_TYPE' | 'PREFIXED_TYPE' | 'UNNAMESPACED_TYPE' | 'NOT_JSON' | 'READER_REFUSED';
    constructor(code: SessionEventGuardError['code'], message: string);
}
/** The envelope fields a caller supplies. */
export interface ExternalEventInput {
    /** Type name, namespaced by the plugin, e.g. `filesnap/point`. */
    type: string;
    /** Payload; must survive a JSON round trip without loss. */
    data: unknown;
    /**
     * The sequence number. A handle's first appended event MUST carry the stored
     * next-seq (`SessionHandle.append`), and committed events are never
     * rewritten, so this is read from the handle rather than invented.
     */
    seq: number;
    /** Creation time; defaults to `Date.now()`, injectable for determinism. */
    at?: number;
}
/** One stored event, as the handle seam accepts it. */
export interface ExternalEvent {
    type: string;
    seq: number;
    time: number;
    data: unknown;
    ignorable: true;
}
/**
 * Build one omittable external event.
 *
 * The prefix rule is not cosmetic: the v3→v4 format migration rewrites an
 * unknown omittable type to `` `plugin:${type}` ``. Prefixing by hand stores
 * `plugin:plugin:<type>`, which no later reader or migration recognises.
 *
 * @param input - the caller's fields.
 * @returns the envelope, ready for `handle.append([event])`.
 * @throws {SessionEventGuardError} for a type this build already declares
 *   (write it with `Session.append` instead), a `plugin:`-prefixed type, an
 *   unnamespaced type, or a payload that is not lossless JSON.
 */
export declare function buildExternalEvent(input: ExternalEventInput): ExternalEvent;
//# sourceMappingURL=envelope.d.ts.map