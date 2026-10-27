/**
 * The durable-log audit: ask the storage seam the only question that matters,
 * and report the answer without paraphrasing it.
 *
 * The write-boundary verdict in `classify.ts` is a prediction made from the
 * vocabulary. This module is the measurement: it opens the stored session
 * through `sessionPersistence` — the same service, the same validated read
 * path, the same fail-closed contract a restart uses — and reports whether the
 * read succeeded. When it did not, the refusal itself is the finding, verbatim,
 * because that message already carries the type name and sequence the reader
 * stopped at.
 *
 * One honest limit: a refused log is refused at its **first** unknown required
 * event, so the number of further offenders is not obtainable through this
 * seam. The audit says so rather than reporting the count it can see as the
 * count that exists.
 *
 * @module @argszero/cordis-plugin-session-event-guard/audit
 */
import { standingOf } from "./vocabulary.js";
/**
 * Audit one stored session.
 * @param persistence - the host's `sessionPersistence` service instance.
 * @param id - the stored session to open.
 * @returns the audit; the read seam's failures are reported, never thrown.
 */
export async function auditStoredSession(persistence, id) {
    const empty = { events: 0, known: 0, omittable: 0, required: 0, external: [], truncated: false };
    const snapshot = await persistence.stat(id).catch(() => undefined);
    const sizeBytes = snapshot?.sizeBytes;
    let handle;
    try {
        handle = await persistence.open(id, 'read');
    }
    catch (error) {
        return {
            id,
            loadable: false,
            failure: failureOf(error),
            refusalName: nameOf(error),
            refusal: messageOf(error),
            ...diagnosisOf(error),
            ...empty,
            ...sizeBytes === undefined ? {} : { sizeBytes },
        };
    }
    try {
        const { events } = await handle.read();
        let known = 0;
        let omittable = 0;
        let required = 0;
        const external = [];
        for (const event of events) {
            const standing = standingOf(event.type, event.ignorable);
            if (standing === 'known')
                known += 1;
            else if (standing === 'omittable')
                omittable += 1;
            else
                required += 1;
            if (standing !== 'known')
                external.push({ seq: event.seq, type: event.type, standing });
        }
        return {
            id: handle.header.id,
            loadable: true,
            events: events.length,
            known,
            omittable,
            required,
            external,
            truncated: false,
            ...sizeBytes === undefined ? {} : { sizeBytes },
        };
    }
    catch (error) {
        return {
            id,
            loadable: false,
            failure: failureOf(error),
            refusalName: nameOf(error),
            refusal: messageOf(error),
            ...diagnosisOf(error),
            ...empty,
            truncated: true,
            ...sizeBytes === undefined ? {} : { sizeBytes },
        };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/**
 * Audit up to `limit` stored sessions, newest first.
 * @param persistence - the host's `sessionPersistence` service instance.
 * @param limit - maximum number of sessions to open.
 * @returns the audits plus the store's total, so the caller can disclose coverage.
 */
export async function auditStore(persistence, limit) {
    const snapshots = await persistence.list();
    const newest = [...snapshots].sort((a, b) => b.header.createdAt - a.header.createdAt);
    const audits = [];
    for (const snapshot of newest.slice(0, limit)) {
        audits.push(await auditStoredSession(persistence, snapshot.header.id));
    }
    return { audits, total: newest.length };
}
/** Classify a read failure without inspecting anything but its shape. */
function failureOf(error) {
    if (error instanceof Error && /not found|ENOENT/i.test(`${error.name} ${error.message}`))
        return 'missing';
    return causeOf(error) === undefined ? 'unreadable' : 'refused';
}
/**
 * Which fail-closed contract a reader's own message identifies.
 *
 * Both messages are contract text from the harness, so this reads them rather
 * than predicting them — the same rule the audit follows for the refusal
 * itself.
 * @param error - the error the read seam raised.
 * @returns the cause, or `undefined` when the message identifies no known one.
 */
export function causeOf(error) {
    if (!(error instanceof Error))
        return undefined;
    if (/producer-owned source kind/i.test(error.message))
        return 'retired-source-kind';
    return /ignorable|unknown to this harness/i.test(error.message) ? 'unknown-required-event' : undefined;
}
/** The cause, as a spreadable field, so an absent cause stays absent. */
function diagnosisOf(error) {
    const cause = causeOf(error);
    return cause === undefined ? {} : { cause };
}
/** The error class name, for disclosure. */
function nameOf(error) {
    return error instanceof Error ? error.name : typeof error;
}
/** The reader's message, verbatim. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
