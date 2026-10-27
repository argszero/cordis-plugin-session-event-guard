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
import { defineTool } from '@deepseek-ai/dsh-tools';
import { auditStore, auditStoredSession } from "./audit.js";
import { writeVerdict } from "./classify.js";
import { renderLiveSources, renderSourceVerdict, renderStoreAudit, renderWriteVerdict } from "./report.js";
import { scanEventSources, sourceVerdict } from "./source-kind.js";
import { KNOWN_EVENT_TYPES, standingOf, vocabularyReport } from "./vocabulary.js";
import { installWriteVeto } from "./veto.js";
export { auditStore, auditStoredSession, causeOf } from "./audit.js";
export { writeVerdict } from "./classify.js";
export { buildExternalEvent, SessionEventGuardError } from "./envelope.js";
export { renderLiveSources, renderSessionAudit, renderSourceVerdict, renderStoreAudit, renderWriteVerdict, } from "./report.js";
export { MESSAGE_SLOTS, inspectSource, replacementFor, scanEventSources, slotLabel, sourceVerdict, walkMessageSlots, } from "./source-kind.js";
export { KNOWN_EVENT_TYPES, standingOf, vocabularyReport } from "./vocabulary.js";
export { installWriteVeto, refusalFor, SENTINEL_SEQ, VETO_MARK } from "./veto.js";
export const name = 'session-event-guard';
export const inject = ['tools'];
/**
 * How the write-side veto treats an event the reader would refuse.
 *
 * `refuse` throws at the append site, before the event lands, which is what
 * keeps the log readable. `observe` reports and lets it commit — the shape an
 * operator needs when the goal is to see the real failure on a live session
 * rather than to keep it clean.
 */
export const VETO_MODE = 'refuse';
/** Tool name the model calls. */
export const TOOL = 'session_event_guard';
/**
 * Most offending events kept per session, so a looping writer cannot grow this
 * without bound. Exported because a bound nothing can assert is a comment.
 */
export const LEDGER_LIMIT = 50;
/** Sessions kept in the ledger, newest first. Exported for the same reason. */
export const LEDGER_SESSIONS = 200;
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
export function apply(ctx) {
    const ledger = new Map();
    const sourceLedger = new Map();
    const refused = new Map();
    // The write-side veto. `Session.append` checks the envelope and the surface
    // marker but never the message shape, so a payload no reader will accept
    // lands here first. Shadowing the instance's own `append` is the only seam
    // that sees the event before it is durable.
    const vetoes = new Set();
    ctx.effect(() => () => {
        for (const restore of vetoes)
            restore();
        vetoes.clear();
    });
    ctx.on('session/created', (session) => {
        const handle = installWriteVeto(session, {
            mode: VETO_MODE,
            onRefusal: (refusal) => noteRefusal(session, refusal),
        });
        if (handle.outcome === 'patched')
            vetoes.add(handle.restore);
    });
    /**
     * Record one append the veto stopped, bounded like the other two ledgers.
     * @param session - the session the append was refused on.
     * @param refusal - the type and the reader's sentence.
     */
    function noteRefusal(session, refusal) {
        const offenceList = ledgerFor(refused, session.id);
        const existing = offenceList.get(refusal.type);
        if (existing !== undefined) {
            existing.count += 1;
            return;
        }
        if (offenceList.size >= LEDGER_LIMIT)
            return;
        offenceList.set(refusal.type, { type: refusal.type, sentence: refusal.sentence, count: 1 });
        ctx.logger.warn(`session-event-guard: session "${session.id}" refused an append of "${refusal.type}" at the write`
            + ` boundary (${VETO_MODE} mode): ${refusal.sentence}.`
            + (VETO_MODE === 'refuse'
                ? ' The event was not committed, so this log stays readable by every reader.'
                : ' The event was committed anyway: a reader without this plugin must still refuse this log.'));
    }
    ctx.on('session/event', (session, event) => {
        noteUndeclaredType(session, event);
        noteRefusedSources(session, event);
    });
    /**
     * Report an event type a reader without the writer's plugin must refuse.
     * @param session - the session the event was committed to.
     * @param event - the committed event.
     */
    function noteUndeclaredType(session, event) {
        const standing = standingOf(event.type, event.ignorable);
        if (standing !== 'required')
            return;
        const offenceList = ledgerFor(ledger, session.id);
        const existing = offenceList.get(event.type);
        if (existing !== undefined) {
            existing.count += 1;
            return;
        }
        if (offenceList.size >= LEDGER_LIMIT)
            return;
        offenceList.set(event.type, {
            type: event.type, firstSeq: event.seq, count: 1,
        });
        ctx.logger.warn(`session-event-guard: session "${session.id}" appended event type "${event.type}" (seq ${event.seq}),`
            + ` which this build's vocabulary of ${KNOWN_EVENT_TYPES.size} types does not declare and whose envelope`
            + ' carries no `ignorable` marker. Session.append cannot set that marker, so this is a REQUIRED event:'
            + ' a reader that does not load the writing plugin must refuse this whole log. Write the envelope'
            + ' yourself through ctx.sessionPersistence.open(id, \'write\') with `ignorable: true`'
            + ' (buildExternalEvent() builds it), or keep the payload out of the session log.');
    }
    /**
     * Report a committed message whose `source` the V4 row admission refuses.
     *
     * This runs on the committed event — before the durable write reaches the
     * admission — and it is the only place that can attribute the refusal: the
     * sentence the admission throws names no event, no sequence and no plugin.
     * @param session - the session the event was committed to.
     * @param event - the committed event.
     */
    function noteRefusedSources(session, event) {
        const offences = scanEventSources(event);
        if (offences.length === 0)
            return;
        const offenceList = ledgerFor(sourceLedger, session.id);
        for (const offence of offences) {
            const key = [offence.eventType, offence.slot, offence.defect, offence.plugin ?? offence.kind ?? ''].join('\u0000');
            const existing = offenceList.get(key);
            if (existing !== undefined) {
                existing.count += 1;
                continue;
            }
            if (offenceList.size >= LEDGER_LIMIT)
                continue;
            offenceList.set(key, { ...offence, count: 1 });
            const where = `${offence.eventType} at seq ${offence.seq ?? '?'} slot ${offence.slot}`;
            const who = offence.plugin === undefined ? '' : ` written by plugin "${offence.plugin}"`;
            const fix = offence.fix === undefined
                ? ' Name the producer: any non-empty `source.kind` other than the literal \'plugin\' is admitted.'
                : ` Write ${JSON.stringify(offence.fix.source)} instead.`;
            ctx.logger.warn(`session-event-guard: session "${session.id}" committed ${where}${who} whose \`source.kind\` is`
                + ` ${offence.kind === undefined ? 'absent or not a string' : JSON.stringify(offence.kind)}`
                + ` (${offence.defect}). Session format V4 retired the anonymous \`kind: 'plugin'\` wrapper, and the`
                + ' row admission refuses this message when the append reaches storage — with one sentence that names'
                + ` neither the event nor the plugin.${fix}`);
        }
    }
    /**
     * The per-session offence map, bounded by the exported ledger sizes.
     *
     * Both ledgers go through here so neither can be the one that grows without
     * bound: the ceiling is the same constant for both, and an eviction drops the
     * oldest session rather than the newest offence.
     * @param ledger - the ledger to index.
     * @param id - the session id.
     * @returns the session's map, created when it did not exist.
     */
    function ledgerFor(ledger, id) {
        const existing = ledger.get(id);
        if (existing !== undefined)
            return existing;
        if (ledger.size >= LEDGER_SESSIONS)
            ledger.delete(ledger.keys().next().value);
        const created = new Map();
        ledger.set(id, created);
        return created;
    }
    ctx.tools.register(defineTool({
        name: TOOL,
        description: 'Check whether a custom session event will survive a reader that does not load the plugin that wrote it,'
            + ' and audit stored sessions for events that already will not. Call this before writing your own event'
            + ' type into a session log (pass `type`), when a session fails to load or open after a plugin was'
            + ' removed or an update changed the plugin set (pass `session`), when a turn dies with "format v4'
            + ' message requires a producer-owned source kind" (read the live section of the report), or to survey'
            + ' the stored sessions this process can see (pass neither). Call it before attaching a `source` to a'
            + ' message too (pass `source` as JSON). The write path matters: Session.append builds and freezes the'
            + ' envelope itself and cannot mark an event ignorable, so any event type outside this harness\'s'
            + ' generated vocabulary written that way becomes a REQUIRED event and makes the log unreadable later.',
        parameters: {
            type: {
                type: 'string',
                description: 'One event type a plugin intends to write, e.g. "filesnap/point". Judged before it is written,'
                    + ' on both write paths. Needs no storage backend.',
            },
            source: {
                type: 'string',
                description: 'One `source` object a plugin intends to attach to a durable message, as JSON — e.g.'
                    + ' {"kind":"plugin","plugin":"my-plugin"}. Judged against the V4 producer-owned-source admission'
                    + ' before it is written, and the accepted replacement is printed when one can be derived.'
                    + ' Needs no storage backend.',
            },
            session: {
                type: 'string',
                description: 'Stored session id to open through the persistence read seam. Its refusal, if any, is quoted'
                    + ' verbatim.',
            },
            limit: {
                type: 'integer',
                description: 'How many of the newest stored sessions to open when `session` is omitted. Default 20; the report'
                    + ' states how many were skipped.',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    mode: { type: 'string', required: true },
                    vocabularySize: { type: 'integer', required: true },
                    vocabularyVersion: { type: 'string', required: true },
                    writeType: { type: 'string' },
                    writeVerdict: { type: 'string' },
                    sourceKind: { type: 'string' },
                    sourceDefect: { type: 'string' },
                    sourceAdmitted: { type: 'boolean' },
                    audited: { type: 'integer', required: true },
                    total: { type: 'integer', required: true },
                    refused: { type: 'integer', required: true },
                    refusedSessions: { type: 'array', required: true, items: { type: 'string' } },
                    liveTypes: { type: 'array', required: true, items: { type: 'string' } },
                    liveSources: { type: 'array', required: true, items: { type: 'string' } },
                    report: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
        },
        async execute(rawArgs) {
            const args = rawArgs;
            const vocabulary = vocabularyReport();
            const sections = [];
            const modes = [];
            let write;
            let source;
            let audits = [];
            let total = 0;
            if (args.type !== undefined) {
                modes.push('preflight');
                write = writeVerdict(args.type);
                sections.push(renderWriteVerdict(write, vocabulary));
            }
            if (args.source !== undefined) {
                modes.push('source');
                source = sourceVerdict(args.source);
                sections.push(renderSourceVerdict(source));
            }
            const persistence = ctx.get('sessionPersistence');
            const wantsStorage = args.session !== undefined || write === undefined && source === undefined;
            if (wantsStorage && persistence === undefined) {
                modes.push('unavailable');
                sections.push([
                    'Session log audit — unavailable.',
                    '',
                    'This process provides no `sessionPersistence` service, so no stored log can be opened. The',
                    'write-boundary verdict above is unaffected: it is computed from the vocabulary and the',
                    'session.append contract, neither of which needs a backend.',
                ].join('\n'));
            }
            else if (wantsStorage && persistence !== undefined) {
                if (args.session !== undefined) {
                    modes.push('audit');
                    audits = [await auditStoredSession(persistence, args.session)];
                    total = audits.length;
                    sections.push(renderStoreAudit(audits, total));
                }
                else {
                    modes.push('store');
                    const limit = Math.max(1, Math.min(args.limit ?? 20, 500));
                    const swept = await auditStore(persistence, limit);
                    audits = swept.audits;
                    total = swept.total;
                    sections.push(renderStoreAudit(audits, total));
                }
            }
            const live = [...ledger.entries()].map(([id, offences]) => ({
                id,
                offences: [...offences.values()],
            }));
            sections.push(renderLive(live));
            const liveSources = [...sourceLedger.entries()].map(([id, offences]) => ({
                id,
                offences: [...offences.values()],
            }));
            sections.push(renderLiveSources(liveSources));
            const refused = audits.filter(audit => !audit.loadable);
            return {
                mode: modes.join('+'),
                vocabularySize: vocabulary.size,
                vocabularyVersion: vocabulary.version,
                ...write === undefined ? {} : { writeType: write.type, writeVerdict: write.verdict },
                ...source === undefined ? {} : {
                    sourceKind: source.inspection.kind ?? '',
                    sourceDefect: source.inspection.defect ?? '',
                    sourceAdmitted: source.admitted,
                },
                audited: audits.length,
                total,
                refused: refused.length,
                refusedSessions: refused.map(audit => audit.id),
                liveTypes: live.flatMap(entry => entry.offences.map(offence => offence.type)),
                liveSources: liveSources.flatMap(entry => entry.offences.map(offence => `${offence.eventType}@${offence.seq ?? '?'}:${offence.slot}:${offence.defect}`)),
                report: sections.join('\n\n'),
            };
        },
    }));
}
/**
 * Render the live ledger.
 * @param live - per-session offences observed in this process.
 * @returns the section text.
 */
function renderLive(live) {
    if (live.length === 0) {
        return [
            'Live write boundary — nothing to report.',
            '',
            'No session appended an event outside this build\'s vocabulary during this process. Note what this',
            'does and does not cover: it observes events that reach the live log through `Session.append`, which',
            'is the path that cannot mark an event omittable. An event written through the handle seam is by',
            'definition omittable and never re-emits as `session/event`, so it is invisible here — that is the',
            'safe path, not a blind spot.',
        ].join('\n');
    }
    const lines = ['Live write boundary — events a reader without the writer\'s plugin must refuse:', ''];
    for (const entry of live) {
        lines.push(`  session ${entry.id}`);
        for (const offence of entry.offences) {
            lines.push(`    seq ${offence.firstSeq}  ${offence.type}${offence.count > 1 ? `  (x${offence.count})` : ''}`);
        }
    }
    return lines.join('\n');
}
