/**
 * The write-side veto.
 *
 * `Session.append` validates the event envelope, the surface marker and the
 * request-header rules — and it says so itself: `validateSessionEventData`
 * documents that it "does not validate complete event payloads"
 * (`packages/core/session/src/surface.ts`), and the message-shape invariants
 * live in `assertMessageEventShape`, which the append path never calls. A
 * message whose `content` is not a parts array therefore appends successfully,
 * and the *reader* refuses the log later with
 * `session event at seq N message has invalid content` — in whatever process
 * opens it next, which may be a different one, without this plugin.
 *
 * The reader's validator is not exported, but the exported `adoptSessionEvent`
 * runs it (`validateSessionEventData` → `validateSurfaceMetadata` →
 * `assertMessageEventShape`). So this module asks the package instead of
 * duplicating it: it builds the envelope `append` is about to build, hands it
 * to the host's own `adoptSessionEvent` (see `./host.ts`), and refuses the append
 * when that throws.
 *
 * Two details make the oracle exact rather than approximate:
 *
 * - **The sequence number is a sentinel.** Every surface rule that mentions
 *   `seq` forbids something from being *not earlier* than it
 *   (`op.startSeq >= event.seq`, `source >= event.seq`, and the shadowed-node
 *   coverage check against the empty list passed here). One value larger than
 *   any real sequence makes every such rule pass for a legitimate event, so a
 *   refusal can only come from a genuine defect — the alternative, guessing the
 *   next sequence, would refuse a legitimate `replace` op whose `startSeq` is
 *   below the guess.
 * - **The payload is cloned.** `adoptSessionEvent` deep-freezes what it
 *   accepts, and freezing the caller's object on the way past would be this
 *   plugin mutating a value it was only asked to judge.
 *
 * A refusal is thrown, because that is what stops the event landing: the
 * caller gets the reader's own sentence at the append site instead of a silent
 * poison that surfaces on the next cold load. `observe` mode reports and
 * commits anyway, for an operator who needs the session to keep running.
 *
 * @module @argszero/cordis-plugin-session-event-guard/veto
 */
/** Brand an installed veto carries, so a second install is a no-op. */
export declare const VETO_MARK: unique symbol;
/**
 * Sequence used when judging a candidate.
 *
 * Larger than any sequence a session can hold, so every ordering rule that
 * guards against "not earlier" passes for a legitimate event.
 */
export declare const SENTINEL_SEQ: number;
/** What one refused append was, and what the reader would have said. */
export interface VetoRefusal {
    /** Event type the caller tried to append. */
    type: string;
    /** The reader's sentence, quoted from the package's own validator. */
    sentence: string;
}
/** What happened to one session. */
export type VetoOutcome = 'patched' | 'already-guarded' | 'not-writable' | 'no-append';
/** The installed veto and its undo. */
export interface VetoHandle {
    /** Whether this call installed the shadow. */
    outcome: VetoOutcome;
    /** Remove the shadow, if this call installed it and it is still ours. */
    restore: () => void;
}
/** How the veto treats a refused append. */
export type VetoMode = 'refuse' | 'observe';
/** Options for {@link installWriteVeto}. */
export interface VetoOptions {
    /** `refuse` throws before the event lands; `observe` reports and commits anyway. */
    mode: VetoMode;
    /** Called once per refused append, before the decision takes effect. */
    onRefusal: (refusal: VetoRefusal) => void;
}
/**
 * Ask the package's own adoption path whether it would accept this event.
 *
 * The candidate is the envelope `append` is about to build, judged at a
 * sentinel sequence so that no ordering rule can fire on a legitimate event.
 * @param type - the event type the caller passed to `append`.
 * @param data - the payload the caller passed to `append`.
 * @param intent - the surface intent the caller passed, when it passed one.
 * @returns the refusal, or undefined when the event would be accepted.
 */
export declare function refusalFor(type: string, data: unknown, intent: unknown): VetoRefusal | undefined;
/**
 * Shadow one session's `append` so an event no reader would accept cannot land.
 *
 * Every failure to install is an outcome rather than a throw: a session this
 * plugin could not guard is a session that keeps the defect, not a reason to
 * fail the lifecycle edge that delivered it.
 * @param session - the live session to guard.
 * @param options - the mode and the refusal observer.
 * @returns the outcome and an undo.
 */
export declare function installWriteVeto(session: unknown, options: VetoOptions): VetoHandle;
//# sourceMappingURL=veto.d.ts.map