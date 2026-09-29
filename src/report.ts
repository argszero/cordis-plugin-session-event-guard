/**
 * Rendering. The report is the artifact a plugin author reads, so it states
 * the two write paths as measurements, and quotes a reader's refusal verbatim
 * rather than summarizing it — the refusal's own wording carries the type name
 * and sequence the reader stopped at.
 *
 * @module @argszero/cordis-plugin-session-event-guard/report
 */

import type { WriteVerdict } from './classify.ts'
import type { SessionAudit } from './audit.ts'
import type { VocabularyReport } from './vocabulary.ts'

/** One wrapped key/value line. */
function row(label: string, value: string): string {
  return `  ${`${label} `.padEnd(32, '.')} ${value}`
}

/**
 * Render the write-boundary verdict.
 * @param verdict - the verdict from {@link writeVerdict}.
 * @param vocabulary - which build answered.
 * @returns the report text.
 */
export function renderWriteVerdict(verdict: WriteVerdict, vocabulary: VocabularyReport): string {
  const lines = [
    `Session event write audit — "${verdict.type}"`,
    '',
    verdict.verdict === 'safe'
      ? 'Verdict: SAFE — this type is interpreted by every build of this line.'
      : 'Verdict: SEAM-REQUIRED — written with session.append this type makes the session unreadable'
        + ' to a reader that does not load the writing plugin.',
    '',
    row('vocabulary', `${vocabulary.size} event types from @deepseek-ai/dsh-session@${vocabulary.version}`),
    row('in the vocabulary', verdict.inVocabulary ? 'yes' : 'no'),
    row('envelope from session.append', verdict.natural),
    row('append can set `ignorable`', String(verdict.appendCanMarkOmittable)),
    row('envelope through the handle seam', verdict.seam),
    '',
    'What to do:',
    ...verdict.advice.map((line, index) => `${index + 1}. ${line}`),
  ]
  return lines.join('\n')
}

/**
 * Render one session audit section.
 * @param audit - the audit for one stored session.
 * @returns the section text.
 */
export function renderSessionAudit(audit: SessionAudit): string {
  const size = audit.sizeBytes === undefined ? '' : `, ${audit.sizeBytes} bytes`
  if (audit.loadable) {
    const lines = [
      `LOADABLE  ${audit.id}`,
      `  ${audit.events} events${size}: ${audit.known} known, ${audit.omittable} omittable, ${audit.required} required`,
    ]
    if (audit.external.length > 0) {
      lines.push('  events outside this build\'s vocabulary:')
      for (const record of audit.external) {
        lines.push(`    seq ${record.seq}  ${record.standing.padEnd(9)} ${record.type}`)
      }
    }
    return lines.join('\n')
  }
  const lines = [
    `REFUSED   ${audit.id}`,
    `  failure: ${audit.failure ?? 'unknown'}${audit.refusalName === undefined ? '' : ` (${audit.refusalName})`}`,
  ]
  if (audit.refusal !== undefined) {
    lines.push('  the reader said, verbatim:')
    for (const line of audit.refusal.split('\n')) lines.push(`    ${line}`)
  }
  if (audit.truncated) {
    lines.push(
      '  A refusal stops at the log\'s FIRST unknown required event, so the events above it were never',
      '  enumerated: this log may carry more offenders than the one the message names.',
    )
  }
  return lines.join('\n')
}

/**
 * Render the store-wide audit, disclosing how much of the store was opened.
 * @param audits - the per-session audits.
 * @param total - how many stored sessions exist.
 * @returns the report text.
 */
export function renderStoreAudit(audits: SessionAudit[], total: number): string {
  const refused = audits.filter(audit => !audit.loadable).length
  const lines = [
    `Session log audit — ${audits.length} of ${total} stored session(s) opened`,
    '',
    `${refused} of ${audits.length} could not be read by this build.`,
    '',
    ...audits.map(audit => `${renderSessionAudit(audit)}\n`),
  ]
  if (audits.length < total) {
    lines.push(
      `Coverage: ${total - audits.length} of ${total} stored session(s) were NOT opened (the newest`
      + ` ${audits.length} were). Raise \`limit\` to widen the audit; a clean result here does not speak`
      + ' for the sessions that were not opened.',
    )
  }
  return lines.join('\n')
}
