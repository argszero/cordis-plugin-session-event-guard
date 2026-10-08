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

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { standingOf } from './vocabulary.ts'
import type { EventStanding } from './vocabulary.ts'

/** One unrecognized event the audit could actually see. */
export interface ExternalEventRecord {
  seq: number
  type: string
  standing: EventStanding
}

/** Why a stored session could not be read. */
export type AuditFailure = 'refused' | 'missing' | 'unreadable'

/**
 * Which fail-closed contract the reader refused the log under, when its own
 * message identifies it.
 *
 * The distinction is not cosmetic. The unknown-event refusal names the type and
 * the sequence it stopped at; the retired-source-kind refusal does not name
 * anything, because it is raised while decoding a physical row and the row
 * carries no such context. An audit that presented both as "refused" would
 * leave the reader of the report with the second kind of dead end the plugin
 * exists to remove.
 */
export type AuditCause = 'unknown-required-event' | 'retired-source-kind'

/** What one stored session looks like through the public read seam. */
export interface SessionAudit {
  id: string
  /** Whether a reader loaded the log. Ground truth from the storage seam. */
  loadable: boolean
  /** Which failure, when `loadable` is false. */
  failure?: AuditFailure
  /** The reader's own message, verbatim, when it refused. */
  refusal?: string
  /** The refusal's error class name. */
  refusalName?: string
  /** Which fail-closed contract refused it, when the message says. */
  cause?: AuditCause
  /** Events in the loaded log; `0` when nothing loaded. */
  events: number
  /** Counts over the loaded log, by standing. */
  known: number
  omittable: number
  required: number
  /** Every event outside this build's vocabulary, in seq order. */
  external: ExternalEventRecord[]
  /**
   * True when a refusal stopped the enumeration before the end of the log, so
   * `external` is a lower bound rather than the complete set.
   */
  truncated: boolean
  /** Physical size in bytes, when the backend reports it cheaply. */
  sizeBytes?: number
}

/**
 * Audit one stored session.
 * @param persistence - the host's `sessionPersistence` service instance.
 * @param id - the stored session to open.
 * @returns the audit; the read seam's failures are reported, never thrown.
 */
export async function auditStoredSession(persistence: SessionPersistence, id: SessionId): Promise<SessionAudit> {
  const empty = { events: 0, known: 0, omittable: 0, required: 0, external: [], truncated: false }
  const snapshot = await persistence.stat(id).catch(() => undefined)
  const sizeBytes = snapshot?.sizeBytes
  let handle
  try {
    handle = await persistence.open(id, 'read')
  } catch (error) {
    return {
      id,
      loadable: false,
      failure: failureOf(error),
      refusalName: nameOf(error),
      refusal: messageOf(error),
      ...diagnosisOf(error),
      ...empty,
      ...sizeBytes === undefined ? {} : { sizeBytes },
    }
  }
  try {
    const { events } = await handle.read()
    let known = 0
    let omittable = 0
    let required = 0
    const external: ExternalEventRecord[] = []
    for (const event of events) {
      const standing = standingOf(event.type, event.ignorable)
      if (standing === 'known') known += 1
      else if (standing === 'omittable') omittable += 1
      else required += 1
      if (standing !== 'known') external.push({ seq: event.seq, type: event.type, standing })
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
    }
  } catch (error) {
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
    }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/**
 * Audit up to `limit` stored sessions, newest first.
 * @param persistence - the host's `sessionPersistence` service instance.
 * @param limit - maximum number of sessions to open.
 * @returns the audits plus the store's total, so the caller can disclose coverage.
 */
export async function auditStore(
  persistence: SessionPersistence,
  limit: number,
): Promise<{ audits: SessionAudit[]; total: number }> {
  const snapshots = await persistence.list()
  const newest = [...snapshots].sort((a, b) => b.header.createdAt - a.header.createdAt)
  const audits: SessionAudit[] = []
  for (const snapshot of newest.slice(0, limit)) {
    audits.push(await auditStoredSession(persistence, snapshot.header.id))
  }
  return { audits, total: newest.length }
}

/** Classify a read failure without inspecting anything but its shape. */
function failureOf(error: unknown): AuditFailure {
  if (error instanceof Error && /not found|ENOENT/i.test(`${error.name} ${error.message}`)) return 'missing'
  return causeOf(error) === undefined ? 'unreadable' : 'refused'
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
export function causeOf(error: unknown): AuditCause | undefined {
  if (!(error instanceof Error)) return undefined
  if (/producer-owned source kind/i.test(error.message)) return 'retired-source-kind'
  return /ignorable|unknown to this harness/i.test(error.message) ? 'unknown-required-event' : undefined
}

/** The cause, as a spreadable field, so an absent cause stays absent. */
function diagnosisOf(error: unknown): { cause?: AuditCause } {
  const cause = causeOf(error)
  return cause === undefined ? {} : { cause }
}

/** The error class name, for disclosure. */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** The reader's message, verbatim. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
