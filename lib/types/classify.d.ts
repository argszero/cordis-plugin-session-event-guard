/**
 * The write-boundary verdict for a type name a plugin intends to write.
 *
 * There are exactly two ways an event reaches a session log, and they do not
 * have the same powers:
 *
 * - `Session.append(type, data)` builds and freezes the envelope itself
 *   (`packages/core/session/src/index.ts:722`): the object it freezes is
 *   `{ type, seq, time, data, ...surfaceMetadata }`. There is no `ignorable`
 *   field, and no parameter that could add one, so **every event written this
 *   way is a required event**. That is a property of the call, not of the
 *   caller — a plugin cannot opt out of it.
 * - `SessionHandle.append(events)` accepts caller-owned envelopes
 *   (`packages/session/session-persistence/src/handle.ts:97`) and does not
 *   strip a marker the caller set. This is the seam that can produce an
 *   `omittable` event, and it is public: `message-feedback` reaches it through
 *   `ctx.sessionPersistence.open(id, 'write')`
 *   (`packages/feedback/message-feedback/src/index.ts:267`).
 *
 * Put together: a type this build does not know, written through the natural
 * API, is not *probably* unreadable later — it is unreadable later by
 * construction, for every reader whose vocabulary does not contain that type,
 * which includes every reader that does not load the writing plugin. The
 * refusal happens on the next cold load, long after the write succeeded.
 *
 * @module @argszero/cordis-plugin-session-event-guard/classify
 */
import type { EventStanding } from './vocabulary.ts';
/** What a plugin's intended write will do, and what to do about it. */
export interface WriteVerdict {
    /** The type name, verbatim. */
    type: string;
    /** Whether this build's generated vocabulary declares the type. */
    inVocabulary: boolean;
    /**
     * The payload slots this event type declares for durable messages, when it
     * declares any. Each one is admitted separately, by `source.kind`, and a
     * second verdict judges that field (`sourceVerdict`).
     */
    sourceSlots: string[];
    /** The standing of the envelope `Session.append(type, data)` builds. */
    natural: EventStanding;
    /**
     * Whether `Session.append` can mark an event omittable. Always `false`: the
     * envelope it freezes has no `ignorable` field and it takes no parameter
     * that could add one. Modelled as a field, not a comment, so a test can
     * assert it against the real call rather than against this prose.
     */
    appendCanMarkOmittable: false;
    /** The standing of the same type written through the handle seam with the marker set. */
    seam: EventStanding;
    /** `safe` when the natural call already produces a readable event; `seam-required` otherwise. */
    verdict: 'safe' | 'seam-required';
    /** Ordered, concrete steps. */
    advice: string[];
}
/**
 * Judge one type name on both write paths.
 * @param type - the event type name as the plugin intends to store it.
 * @returns the verdict.
 */
export declare function writeVerdict(type: string): WriteVerdict;
//# sourceMappingURL=classify.d.ts.map