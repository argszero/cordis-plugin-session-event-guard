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
 * to `adoptSessionEvent`, and refuses the append when that throws.
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
import { adoptSessionEvent } from '@deepseek-ai/dsh-session';
import { SessionEventGuardError } from "./envelope.js";
/** Brand an installed veto carries, so a second install is a no-op. */
export const VETO_MARK = Symbol.for('argszero.cordis-plugin-session-event-guard/write-veto');
/**
 * Sequence used when judging a candidate.
 *
 * Larger than any sequence a session can hold, so every ordering rule that
 * guards against "not earlier" passes for a legitimate event.
 */
export const SENTINEL_SEQ = Number.MAX_SAFE_INTEGER;
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
export function refusalFor(type, data, intent) {
    let payload;
    try {
        payload = structuredClone(data);
    }
    catch {
        // Not cloneable is not this module's verdict to give: `append` snapshots
        // JSON and refuses what it cannot, with its own sentence.
        return undefined;
    }
    const surface = typeof intent === 'object' && intent !== null
        ? intent
        : undefined;
    const candidate = {
        type,
        seq: SENTINEL_SEQ,
        time: 0,
        data: payload,
        ...surface?.surfaceOp === undefined ? {} : { surfaceOp: surface.surfaceOp },
        ...surface?.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: surface.sourceEventSeqs },
    };
    try {
        adoptSessionEvent(candidate);
        return undefined;
    }
    catch (error) {
        // A payload `append` refuses on its own terms is not this module's verdict.
        // `append` snapshots the data as JSON and refuses what cannot be snapshotted
        // (BigInt, a function, a cycle) with a sentence that names the real problem,
        // in every process, with or without this plugin — so refusing it here with a
        // shape sentence would both pre-empt the accurate one and claim a durability
        // hazard that does not exist. Only the failure path pays for this check.
        if (!isJsonPayload(payload))
            return undefined;
        return { type, sentence: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Whether a value survives the snapshot `Session.append` performs.
 *
 * The round trip is compared rather than merely attempted: `NaN`, `undefined`
 * members and sparse arrays all stringify without throwing, and `append`
 * refuses every one of them.
 * @param value - the cloned payload.
 * @returns whether `append` would accept it as JSON.
 */
function isJsonPayload(value) {
    let text;
    try {
        text = JSON.stringify(value);
    }
    catch {
        return false;
    }
    if (text === undefined)
        return false;
    try {
        return sameJson(JSON.parse(text), value);
    }
    catch {
        return false;
    }
}
/**
 * Structural equality over the JSON value domain.
 *
 * `NaN` is unequal to itself, so a payload carrying one is reported as not
 * surviving the round trip — which is what `append` says about it.
 * @param left - the round-tripped value.
 * @param right - the original payload.
 * @returns whether the two are the same JSON value.
 */
function sameJson(left, right) {
    if (typeof left === 'number' && typeof right === 'number')
        return left === right;
    if (left === right)
        return true;
    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null)
        return false;
    if (Array.isArray(left) !== Array.isArray(right))
        return false;
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((item, index) => sameJson(item, right[index]));
    }
    const leftRecord = left;
    const rightRecord = right;
    const leftKeys = Object.keys(leftRecord);
    if (leftKeys.length !== Object.keys(rightRecord).length)
        return false;
    return leftKeys.every(key => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]));
}
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
export function installWriteVeto(session, options) {
    if (session === undefined || session === null)
        return { outcome: 'no-append', restore: () => { } };
    const current = session.append;
    if (typeof current !== 'function')
        return { outcome: 'no-append', restore: () => { } };
    if (current[VETO_MARK] === true)
        return { outcome: 'already-guarded', restore: () => { } };
    const original = current;
    // A prototype method must be revealed again by deleting the shadow; an own
    // property by writing the old value back.
    const hadOwn = Object.prototype.hasOwnProperty.call(session, 'append');
    const wrapper = function vetoedAppend(...args) {
        const type = args[0];
        if (typeof type === 'string') {
            const refusal = refusalFor(type, args[1], args[2]);
            if (refusal !== undefined) {
                options.onRefusal(refusal);
                if (options.mode === 'refuse') {
                    const id = session.id;
                    throw new SessionEventGuardError('READER_REFUSED', `refusing to append ${type} to session ${typeof id === 'string' ? `"${id}"` : '(unknown)'}:`
                        + ` ${refusal.sentence}. This event was not committed. A reader that does not load this plugin`
                        + ' would have refused the whole log later, in a process that could not attribute it.');
                }
            }
        }
        return Reflect.apply(original, session, args);
    };
    wrapper[VETO_MARK] = true;
    try {
        ;
        session.append = wrapper;
    }
    catch {
        // A sealed session, or an `append` defined without a setter.
        return { outcome: 'not-writable', restore: () => { } };
    }
    // A refused write is not always a throw — a frozen object in sloppy mode
    // ignores it — so the install is confirmed by reading it back.
    if (session.append !== wrapper) {
        return { outcome: 'not-writable', restore: () => { } };
    }
    let installed = true;
    return {
        outcome: 'patched',
        restore: () => {
            if (!installed)
                return;
            installed = false;
            // Only unwind a shadow that is still ours: a later guard may have
            // replaced it, and undoing that would be writing a third party's state.
            if (session.append !== wrapper)
                return;
            if (hadOwn)
                session.append = original;
            else
                delete session.append;
        },
    };
}
