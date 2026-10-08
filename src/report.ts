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
import type { SourceOffence, SourceVerdict } from './source-kind.ts'
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
    ...verdict.sourceSlots.length === 0 ? [] : [
      row('message slots it declares', verdict.sourceSlots.join(', ')),
      '',
      'Each message in those slots is admitted separately, by `source.kind` — a second, independent',
      'write-boundary check. Pass the source object to this tool as `source` to judge that one too.',
    ],
    '',
    'What to do:',
    ...verdict.advice.map((line, index) => `${index + 1}. ${line}`),
  ]
  return lines.join('\n')
}

/**
 * Render the producer-owned source verdict.
 * @param verdict - the verdict from {@link sourceVerdict}.
 * @returns the report text.
 */
export function renderSourceVerdict(verdict: SourceVerdict): string {
  const lines = [
    `Message source write audit — ${verdict.parsed ? verdict.input : 'the argument did not parse as JSON'}`,
    '',
    verdict.admitted
      ? 'Verdict: ADMITTED — the V4 row admission accepts this source as written.'
      : 'Verdict: REFUSED — the V4 row admission throws on the append that carries this message, and the'
        + ' sentence it throws names neither the event nor the plugin.',
    '',
    ...verdict.parsed ? [
      row('source.kind', verdict.inspection.kind ?? '(absent)'),
      row('source.plugin', verdict.inspection.plugin ?? '(absent)'),
      row('refused clause', verdict.inspection.defect ?? 'none'),
    ] : [],
  ]
  if (verdict.fix !== undefined) {
    lines.push('', `Write instead: ${JSON.stringify(verdict.fix.source)}`)
  }
  return [...lines, '', 'What to do:', ...verdict.advice.map((line, index) => `${index + 1}. ${line}`)].join('\n')
}

/**
 * Render the live producer-owned-source ledger.
 * @param live - per-session offences observed in this process.
 * @returns the section text.
 */
export function renderLiveSources(live: { id: string; offences: (SourceOffence & { count: number })[] }[]): string {
  if (live.length === 0) {
    return [
      'Live source admission — nothing to report.',
      '',
      'No session committed a message whose `source` the V4 row admission will refuse during this process.',
      'This is the write boundary\'s own view: the observer runs on the committed event, before the durable',
      'write reaches the admission, so an offence here is reported in the process that made it with the',
      'sequence and the payload slot attached.',
    ].join('\n')
  }
  const lines = [
    'Live source admission — messages the V4 write path will refuse, located:',
    '',
  ]
  for (const entry of live) {
    lines.push(`  session ${entry.id}`)
    for (const offence of entry.offences) {
      const at = offence.seq === undefined ? '' : `seq ${offence.seq}  `
      const plugin = offence.plugin === undefined ? '' : `  plugin="${offence.plugin}"`
      lines.push(`    ${at}${offence.eventType}  ${offence.slot}  ${offence.defect}${plugin}`
        + `${offence.count > 1 ? `  (x${offence.count})` : ''}`)
      if (offence.fix !== undefined) lines.push(`      write instead: ${JSON.stringify(offence.fix.source)}`)
    }
  }
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
  if (audit.cause === 'retired-source-kind') {
    lines.push(
      '  This is the V4 producer-owned-source admission, and it is raised while DECODING A PHYSICAL ROW —',
      '  which is why the sentence names no event, no sequence and no plugin. The offender is the first row',
      '  whose message still carries the retired `{"kind":"plugin"}` wrapper.',
      '  This audit cannot locate that row: the read is refused at it, so nothing after it was parsed and',
      '  nothing before it identifies the writer. The process that WROTE the message can: the live observer',
      '  reports the same defect with the event type, the sequence and the payload slot attached, because it',
      '  runs on the committed event, before the durable write reaches this admission.',
    )
  } else if (audit.truncated) {
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
