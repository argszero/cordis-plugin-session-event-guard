/**
 * One session-log mistake an external plugin cannot see from where it stands.
 *
 * A plugin may extend `SessionEventMap` by declaration merging, so
 * `session.append('filesnap/point', data)` compiles and works in the running
 * process. The envelope it writes is built and frozen by `Session.append`
 * itself, and that object has no `ignorable` field — the call offers no
 * parameter that could add one. Meanwhile the storage read path refuses any
 * event type outside this build's generated vocabulary unless the envelope
 * carries exactly that marker
 * (`packages/session/session-persistence/src/storage-contract.ts`). Out-of-repo
 * types are outside the generated set by construction, which the vocabulary
 * module states in its own doc comment.
 *
 * So the write succeeds and the *read* fails, later, in a different process:
 * the log of a session written by a plugin becomes unreadable to every reader
 * that does not load that plugin — including the same harness after the plugin
 * is uninstalled. The reporter of the discussion this package answers put it
 * precisely: compatibility must rest on the persisted marker, not on the
 * plugin composition of whoever happens to read.
 *
 * This package does not change the core contract and does not write to any
 * session log — it refuses a write rather than performing one. It supplies what
 * is missing around it:
 *
 * - a **write-boundary verdict** for a type name, stating both write paths and
 *   the one thing `Session.append` cannot do;
 * - a **durable-log audit** that opens stored sessions through the same
 *   validated read seam a restart uses, and quotes the reader's refusal
 *   verbatim instead of predicting it;
 * - a **live observer** on `session/event`, so the mistake is reported in the
 *   process that made it, with the type and sequence, rather than discovered
 *   on the next cold load;
 * - a **write-side veto** that shadows each session's `append` and refuses a
 *   payload no reader would accept before it lands, quoting the reader's own
 *   sentence — the second half of the same problem, where `Session.append`
 *   checks the envelope but not the message shape;
 * - **`buildExternalEvent`**, the envelope the handle seam accepts, with the
 *   four refusals a hand-rolled one gets wrong.
 *
 * ```yaml
 * - id: session-event-guard
 *   name: '@argszero/cordis-plugin-session-event-guard'
 * ```
 *
 * @module @argszero/cordis-plugin-session-event-guard
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SourceOffence } from './source-kind.ts';
import type { VetoMode } from './veto.ts';
export { auditStore, auditStoredSession, causeOf } from './audit.ts';
export type { AuditCause, AuditFailure, ExternalEventRecord, SessionAudit } from './audit.ts';
export { writeVerdict } from './classify.ts';
export type { WriteVerdict } from './classify.ts';
export { buildExternalEvent, SessionEventGuardError } from './envelope.ts';
export type { ExternalEvent, ExternalEventInput } from './envelope.ts';
export { renderLiveSources, renderSessionAudit, renderSourceVerdict, renderStoreAudit, renderWriteVerdict, } from './report.ts';
export { MESSAGE_SLOTS, inspectSource, replacementFor, scanEventSources, slotLabel, sourceVerdict, walkMessageSlots, } from './source-kind.ts';
export type { MessageSlotSpec, SourceDefect, SourceInspection, SourceOffence, SourceReplacement, SourceVerdict, } from './source-kind.ts';
export { KNOWN_EVENT_TYPES, standingOf, vocabularyReport } from './vocabulary.ts';
export type { EventStanding, VocabularyReport } from './vocabulary.ts';
export { installWriteVeto, refusalFor, SENTINEL_SEQ, VETO_MARK } from './veto.ts';
export type { VetoHandle, VetoMode, VetoOutcome, VetoRefusal } from './veto.ts';
export declare const name = "session-event-guard";
export declare const inject: string[];
/**
 * How the write-side veto treats an event the reader would refuse.
 *
 * `refuse` throws at the append site, before the event lands, which is what
 * keeps the log readable. `observe` reports and lets it commit — the shape an
 * operator needs when the goal is to see the real failure on a live session
 * rather than to keep it clean.
 */
export declare const VETO_MODE: VetoMode;
/** Tool name the model calls. */
export declare const TOOL = "session_event_guard";
/**
 * Most offending events kept per session, so a looping writer cannot grow this
 * without bound. Exported because a bound nothing can assert is a comment.
 */
export declare const LEDGER_LIMIT = 50;
/** Sessions kept in the ledger, newest first. Exported for the same reason. */
export declare const LEDGER_SESSIONS = 200;
/** One live event that a reader without the writer's plugin must refuse. */
export interface LiveOffence {
    type: string;
    /** Sequence of the first event of this type seen; later ones are counted only. */
    firstSeq: number;
    /** How many events of this type were seen. */
    count: number;
}
/**
 * One live message whose `source` the V4 row admission refuses.
 *
 * A second ledger, keyed by what actually offends (event type, payload slot,
 * clause and producer) rather than by event type: the same event can carry two
 * offending messages in different slots, and they need different fixes.
 */
export interface LiveSourceOffence extends SourceOffence {
    /** How many times this exact offence was seen. */
    count: number;
}
/** One append the veto stopped, or — in `observe` mode — only reported. */
export interface LiveRefusal {
    /** Event type the caller tried to append. */
    type: string;
    /** The reader's sentence, quoted from the package's own validator. */
    sentence: string;
    /** How many times this exact type was refused. */
    count: number;
}
/** Arguments the tool accepts. */
export interface GuardToolArgs {
    /** One event type a plugin intends to write, to be judged before it is written. */
    type?: string;
    /** One `source` object, as JSON, a plugin intends to attach to a message. */
    source?: string;
    /** One stored session to open and audit. */
    session?: string;
    /** How many of the newest stored sessions to open when no `session` is named. */
    limit?: number;
}
/** The tool's canonical value. */
export interface GuardToolValue {
    mode: string;
    vocabularySize: number;
    vocabularyVersion: string;
    writeType?: string;
    writeVerdict?: string;
    sourceKind?: string;
    sourceDefect?: string;
    sourceAdmitted?: boolean;
    audited: number;
    total: number;
    refused: number;
    refusedSessions: string[];
    liveTypes: string[];
    liveSources: string[];
    report: string;
}
/**
 * Register the audit tool and observe live session writes.
 *
 * `sessionPersistence` is looked up with `ctx.get`, not read as a property:
 * this plugin is useful without a durable backend (the write-boundary verdict
 * and the live observer need no service), so the dependency is resolved per
 * call and its absence is reported rather than preventing the plugin from
 * loading.
 * @param ctx - the plugin's context.
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map