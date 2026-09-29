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
 * session log. It supplies what is missing around it:
 *
 * - a **write-boundary verdict** for a type name, stating both write paths and
 *   the one thing `Session.append` cannot do;
 * - a **durable-log audit** that opens stored sessions through the same
 *   validated read seam a restart uses, and quotes the reader's refusal
 *   verbatim instead of predicting it;
 * - a **live observer** on `session/event`, so the mistake is reported in the
 *   process that made it, with the type and sequence, rather than discovered
 *   on the next cold load;
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

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { auditStore, auditStoredSession } from './audit.ts'
import type { SessionAudit } from './audit.ts'
import { writeVerdict } from './classify.ts'
import type { WriteVerdict } from './classify.ts'
import { renderStoreAudit, renderWriteVerdict } from './report.ts'
import { KNOWN_EVENT_TYPES, standingOf, vocabularyReport } from './vocabulary.ts'

export { auditStore, auditStoredSession } from './audit.ts'
export type { AuditFailure, ExternalEventRecord, SessionAudit } from './audit.ts'
export { writeVerdict } from './classify.ts'
export type { WriteVerdict } from './classify.ts'
export { buildExternalEvent, SessionEventGuardError } from './envelope.ts'
export type { ExternalEvent, ExternalEventInput } from './envelope.ts'
export { renderStoreAudit, renderSessionAudit, renderWriteVerdict } from './report.ts'
export { KNOWN_EVENT_TYPES, standingOf, vocabularyReport } from './vocabulary.ts'
export type { EventStanding, VocabularyReport } from './vocabulary.ts'

export const name = 'session-event-guard'
export const inject = ['tools']

/** Tool name the model calls. */
export const TOOL = 'session_event_guard'

/**
 * Most offending events kept per session, so a looping writer cannot grow this
 * without bound. Exported because a bound nothing can assert is a comment.
 */
export const LEDGER_LIMIT = 50

/** Sessions kept in the ledger, newest first. Exported for the same reason. */
export const LEDGER_SESSIONS = 200

/** One live event that a reader without the writer's plugin must refuse. */
export interface LiveOffence {
  type: string
  /** Sequence of the first event of this type seen; later ones are counted only. */
  firstSeq: number
  /** How many events of this type were seen. */
  count: number
}

/** Arguments the tool accepts. */
export interface GuardToolArgs {
  /** One event type a plugin intends to write, to be judged before it is written. */
  type?: string
  /** One stored session to open and audit. */
  session?: string
  /** How many of the newest stored sessions to open when no `session` is named. */
  limit?: number
}

/** The tool's canonical value. */
export interface GuardToolValue {
  mode: string
  vocabularySize: number
  vocabularyVersion: string
  writeType?: string
  writeVerdict?: string
  audited: number
  total: number
  refused: number
  refusedSessions: string[]
  liveTypes: string[]
  report: string
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
export function apply(ctx: Context): void {
  const ledger = new Map<string, Map<string, LiveOffence>>()

  ctx.on('session/event', (session, event) => {
    const standing = standingOf(event.type, event.ignorable)
    if (standing !== 'required') return
    let offences = ledger.get(session.id)
    if (offences === undefined) {
      if (ledger.size >= LEDGER_SESSIONS) ledger.delete(ledger.keys().next().value as string)
      offences = new Map()
      ledger.set(session.id, offences)
    }
    const existing = offences.get(event.type)
    if (existing !== undefined) {
      existing.count += 1
      return
    }
    if (offences.size >= LEDGER_LIMIT) return
    offences.set(event.type, { type: event.type, firstSeq: event.seq, count: 1 })
    ctx.logger.warn(
      `session-event-guard: session "${session.id}" appended event type "${event.type}" (seq ${event.seq}),`
      + ` which this build's vocabulary of ${KNOWN_EVENT_TYPES.size} types does not declare and whose envelope`
      + ' carries no `ignorable` marker. Session.append cannot set that marker, so this is a REQUIRED event:'
      + ' a reader that does not load the writing plugin must refuse this whole log. Write the envelope'
      + ' yourself through ctx.sessionPersistence.open(id, \'write\') with `ignorable: true`'
      + ' (buildExternalEvent() builds it), or keep the payload out of the session log.',
    )
  })

  ctx.tools.register(defineTool({
    name: TOOL,
    description:
      'Check whether a custom session event will survive a reader that does not load the plugin that wrote it,'
      + ' and audit stored sessions for events that already will not. Call this before writing your own event'
      + ' type into a session log (pass `type`), when a session fails to load or open after a plugin was'
      + ' removed or an update changed the plugin set (pass `session`), or to survey the stored sessions this'
      + ' process can see (pass neither). The write path matters: Session.append builds and freezes the'
      + ' envelope itself and cannot mark an event ignorable, so any event type outside this harness\'s'
      + ' generated vocabulary written that way becomes a REQUIRED event and makes the log unreadable later.',
    parameters: {
      type: {
        type: 'string',
        description:
          'One event type a plugin intends to write, e.g. "filesnap/point". Judged before it is written,'
          + ' on both write paths. Needs no storage backend.',
      },
      session: {
        type: 'string',
        description:
          'Stored session id to open through the persistence read seam. Its refusal, if any, is quoted'
          + ' verbatim.',
      },
      limit: {
        type: 'integer',
        description:
          'How many of the newest stored sessions to open when `session` is omitted. Default 20; the report'
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
          audited: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          refused: { type: 'integer', required: true },
          refusedSessions: { type: 'array', required: true, items: { type: 'string' } },
          liveTypes: { type: 'array', required: true, items: { type: 'string' } },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: String(value.report ?? '') }],
    },
    async execute(rawArgs): Promise<GuardToolValue> {
      const args = rawArgs as GuardToolArgs
      const vocabulary = vocabularyReport()
      const sections: string[] = []
      const modes: string[] = []
      let write: WriteVerdict | undefined
      let audits: SessionAudit[] = []
      let total = 0

      if (args.type !== undefined) {
        modes.push('preflight')
        write = writeVerdict(args.type)
        sections.push(renderWriteVerdict(write, vocabulary))
      }

      const persistence = ctx.get('sessionPersistence')
      const wantsStorage = args.session !== undefined || write === undefined
      if (wantsStorage && persistence === undefined) {
        modes.push('unavailable')
        sections.push([
          'Session log audit — unavailable.',
          '',
          'This process provides no `sessionPersistence` service, so no stored log can be opened. The',
          'write-boundary verdict above is unaffected: it is computed from the vocabulary and the',
          'session.append contract, neither of which needs a backend.',
        ].join('\n'))
      } else if (wantsStorage && persistence !== undefined) {
        if (args.session !== undefined) {
          modes.push('audit')
          audits = [await auditStoredSession(persistence, args.session as Parameters<typeof auditStoredSession>[1])]
          total = audits.length
          sections.push(renderStoreAudit(audits, total))
        } else {
          modes.push('store')
          const limit = Math.max(1, Math.min(args.limit ?? 20, 500))
          const swept = await auditStore(persistence, limit)
          audits = swept.audits
          total = swept.total
          sections.push(renderStoreAudit(audits, total))
        }
      }

      const live = [...ledger.entries()].map(([id, offences]) => ({
        id,
        offences: [...offences.values()],
      }))
      sections.push(renderLive(live))

      const refused = audits.filter(audit => !audit.loadable)
      return {
        mode: modes.join('+'),
        vocabularySize: vocabulary.size,
        vocabularyVersion: vocabulary.version,
        ...write === undefined ? {} : { writeType: write.type, writeVerdict: write.verdict },
        audited: audits.length,
        total,
        refused: refused.length,
        refusedSessions: refused.map(audit => audit.id),
        liveTypes: live.flatMap(entry => entry.offences.map(offence => offence.type)),
        report: sections.join('\n\n'),
      }
    },
  }))
}

/**
 * Render the live ledger.
 * @param live - per-session offences observed in this process.
 * @returns the section text.
 */
function renderLive(live: { id: string; offences: LiveOffence[] }[]): string {
  if (live.length === 0) {
    return [
      'Live write boundary — nothing to report.',
      '',
      'No session appended an event outside this build\'s vocabulary during this process. Note what this',
      'does and does not cover: it observes events that reach the live log through `Session.append`, which',
      'is the path that cannot mark an event omittable. An event written through the handle seam is by',
      'definition omittable and never re-emits as `session/event`, so it is invisible here — that is the',
      'safe path, not a blind spot.',
    ].join('\n')
  }
  const lines = ['Live write boundary — events a reader without the writer\'s plugin must refuse:', '']
  for (const entry of live) {
    lines.push(`  session ${entry.id}`)
    for (const offence of entry.offences) {
      lines.push(`    seq ${offence.firstSeq}  ${offence.type}${offence.count > 1 ? `  (x${offence.count})` : ''}`)
    }
  }
  return lines.join('\n')
}
