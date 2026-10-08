/**
 * The second write-boundary mistake, and the one that fails loud without
 * saying anything.
 *
 * The first mistake (`classify.ts`) is a plugin writing an event type this
 * build does not know: the write succeeds and a *later* reader refuses the
 * whole log. This one is the same shape of contract violation with the
 * opposite failure distance — a plugin that builds a **message** the V3 way:
 *
 * ```js
 * createUserMessage({ content: [...], source: { kind: 'plugin', plugin: 'hindsight-memory' } })
 * ```
 *
 * Session format V4 replaced the anonymous `kind: 'plugin'` wrapper with
 * producer-owned attribution: the source kind must be the producer's own
 * identity, and the literal `'plugin'` is **retired syntax**. The admission
 * that refuses it sits at the physical row boundary
 * (`packages/session/session-format-v3-to-v4/src/message-sources.ts`), so it
 * runs on the way to storage — synchronously, inside the append that carries
 * the message — and it throws one fixed sentence:
 *
 * ```
 * format v4 message requires a producer-owned source kind
 * ```
 *
 * That message names no event, no sequence, no plugin and no slot. The turn
 * dies; the author has to bisect their own plugin set to find out which
 * message the harness meant. What is missing is not a verdict — the harness
 * has one and it is correct — it is *attribution*: which event, which
 * sequence, which slot of the payload, which plugin, and what the same source
 * looks like in the shape the admission accepts.
 *
 * That is what this module computes, from the event the session already
 * committed, before the durable write reaches the admission. It reads no
 * internals and changes nothing: the traversal below mirrors the harness's own
 * message walk (`mapEventMessages`), and `test/source-kind.spec.mjs` measures it
 * against the real `assertV4RowAdmission` — the row check the durable write runs
 * — rather than trusting the mirror.
 *
 * One asymmetry is worth knowing, because a report that flattened it would be
 * wrong about where a refusal comes from. The **adoption** walk
 * (`assertV4MessageSources`, over `mapEventMessages`) requires a producer-owned
 * kind on every declared slot, `developer/message` included. The **row** walk
 * (`assertV4SourceRowAdmission`) re-checks only `user/message`,
 * `system/message`, `assistant/message`, `tool/result`,
 * `agent/inbox/spliced` and `session/title-llm-request`: a retired
 * `developer/message` source is refused by that event's own row validator
 * instead, with a sentence of its own that also names `id`, `role` and
 * `content`. Both refuse; they say it differently, and the suite pins both.
 *
 * @module @argszero/cordis-plugin-session-event-guard/source-kind
 */

/** Where a durable event keeps the message(s) whose source is admitted. */
export interface MessageSlotSpec {
  /** The event type that declares message slots. */
  type: string
  /**
   * The slot inside `data`: `self` when the event payload *is* the message,
   * otherwise the key holding one message or an array of them.
   */
  at: 'self' | 'message' | 'inserted' | 'messages'
  /** Whether the slot holds an array of messages. */
  many: boolean
}

/**
 * Every durable event type whose payload declares message slots, and where.
 *
 * This is a mirror of `mapEventMessages`
 * (`packages/session/session-format-v3-to-v4/src/sources.ts`), which is what the
 * adoption admission walks. A mirror can rot, so it is measured: the suite
 * builds an event with a retired source in exactly one slot and requires both
 * that this table finds that slot and that the harness's own
 * `assertV4RowAdmission` refuses the same event.
 */
export const MESSAGE_SLOTS: readonly MessageSlotSpec[] = Object.freeze([
  { type: 'user/message', at: 'self', many: false },
  { type: 'developer/message', at: 'message', many: false },
  { type: 'system/message', at: 'message', many: false },
  { type: 'assistant/message', at: 'message', many: false },
  { type: 'tool/result', at: 'message', many: false },
  { type: 'agent/inbox/spliced', at: 'inserted', many: true },
  { type: 'session/title-llm-request', at: 'messages', many: true },
])

/**
 * The path a slot spec points at, in the shape a report can print.
 * @param spec - one entry of {@link MESSAGE_SLOTS}.
 * @returns e.g. `data`, `data.message`, `data.inserted[]`.
 */
export function slotLabel(spec: MessageSlotSpec): string {
  if (spec.at === 'self') return 'data'
  return `data.${spec.at}${spec.many ? '[]' : ''}`
}

/**
 * Why the producer-owned admission refuses a message source.
 *
 * The harness's check is one boolean expression with four clauses
 * (`source()` in `message-sources.ts`), and naming the clause that fired is the
 * whole value: `'plugin'` is a retired *syntax* with a mechanical replacement,
 * while the other three mean the writer never said who it is.
 */
export type SourceDefect =
  | 'absent'
  | 'not-object'
  | 'kind-missing'
  | 'kind-not-string'
  | 'kind-empty'
  | 'kind-retired'

/** What one message's `source` field is, and what the admission will do with it. */
export interface SourceInspection {
  /** The `kind`, when the source carries one as a string. */
  kind?: string
  /** `source.plugin`, when the source carries one as a string. */
  plugin?: string
  /** The clause the admission refuses on; `undefined` when it accepts the source. */
  defect?: SourceDefect
}

/** The replacement source the harness's own V3→V4 rewrite derives. */
export interface SourceReplacement {
  /** `kind`, as `rewritePluginSource` would set it. */
  kind: string
  /**
   * The whole replacement object: the same source with `plugin` dropped and
   * `kind` set, which is the shape a migrated log carries.
   */
  source: Record<string, unknown>
  /**
   * How the kind was derived. `'plugin-prefix'` is the fallback rule for a name
   * the harness did not release; `undefined` when no faithful replacement can be
   * derived from what the source carries.
   */
  derived: 'plugin-prefix' | undefined
}

/** One message the durable admission will refuse, located. */
export interface SourceOffence {
  /** The event type, verbatim. */
  eventType: string
  /** The event's sequence, when the caller knows it. */
  seq?: number
  /** Where the offending message sits, e.g. `data.inserted[0]`. */
  slot: string
  /** The clause that refuses it. */
  defect: SourceDefect
  /** The `kind` found, verbatim, when there was one. */
  kind?: string
  /** `source.plugin`, when it is a string. */
  plugin?: string
  /** The replacement, when one can be derived faithfully. */
  fix?: SourceReplacement
}

/**
 * Whether a value is a JSON object, **as the harness's own predicate asks it**.
 *
 * This is deliberately `isSessionFormatJsonObject`'s body
 * (`packages/session/session-format/src/json.ts:13`) and not a stricter
 * notion of "plain object": the admission this module mirrors runs that
 * predicate, so a source it accepts and this one does not — a `Date`, a class
 * instance, anything non-array and non-null — would be reported as a refusal
 * that the harness never makes.
 * @param value - candidate.
 * @returns whether the value is an object the harness would walk.
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one `source` the way the producer-owned admission reads it.
 *
 * The four clauses are the harness's, in the harness's order: not an object,
 * `kind` not a string, `kind` empty, `kind` the literal `'plugin'`. Nothing
 * else is refused — the admission is not a whitelist, and saying otherwise is
 * the mistake the discussion this package answers made.
 * @param source - the value found at a message's `source` field.
 * @returns the kind, the plugin name, and the clause that refuses it.
 */
export function inspectSource(source: unknown): SourceInspection {
  if (source === undefined) return { defect: 'absent' }
  if (!isJsonObject(source)) return { defect: 'not-object' }
  const plugin = source['plugin']
  const carried = typeof plugin === 'string' ? { plugin } : {}
  const kind = source['kind']
  if (kind === undefined) return { defect: 'kind-missing', ...carried }
  if (typeof kind !== 'string') return { defect: 'kind-not-string', ...carried }
  if (kind.length === 0) return { defect: 'kind-empty', kind, ...carried }
  if (kind === 'plugin') return { defect: 'kind-retired', kind, ...carried }
  return { kind, ...carried }
}

/**
 * The replacement the harness's own migration derives for a retired wrapper.
 *
 * `rewritePluginSource` (`sources.ts`) drops the `plugin` field and sets `kind`
 * to `producerKind(plugin, role)`, whose fallback is `` `plugin:${plugin}` ``.
 * The fallback is what a third-party plugin's own name derives — which is the
 * audience here. The harness also keeps a table of identities **it** released
 * whose kind is not that fallback; that table is not exported, and for a name
 * in it this suggestion is admitted but not the kind the migration would
 * derive, so {@link SourceReplacement.derived} names the rule that produced it
 * instead of presenting it as the harness's answer.
 * @param inspection - the inspection of the retired source.
 * @param source - the source object the inspection came from, so every other
 *   field survives the rewrite exactly as the harness's own would.
 * @returns the replacement, or `undefined` when no name to derive from exists.
 */
export function replacementFor(
  inspection: SourceInspection,
  source: unknown = undefined,
): SourceReplacement | undefined {
  if (inspection.defect !== 'kind-retired') return undefined
  const plugin = inspection.plugin
  if (plugin === undefined || plugin.length === 0) return undefined
  const kind = `plugin:${plugin}`
  const rest = isJsonObject(source)
    ? Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'kind' && key !== 'plugin'))
    : {}
  return { kind, source: { kind, ...rest }, derived: 'plugin-prefix' }
}

/**
 * Visit every message one event declares, with the slot path that located it.
 *
 * Only messages that are present are visited, and the walk refuses to invent
 * one: a slot that is absent, or an entry that is not an object, is left to the
 * harness's other row checks, which report those with their own messages
 * (`… requires a message array`). Reporting a source defect there would be
 * claiming a refusal this module did not measure.
 * @param event - a durable event, or the row shape that carries the same `data`.
 * @param visit - called once per message with its slot path and value.
 */
export function walkMessageSlots(
  event: { type?: unknown, data?: unknown },
  visit: (slot: string, message: unknown) => void,
): void {
  const type = event.type
  if (typeof type !== 'string') return
  const spec = MESSAGE_SLOTS.find(candidate => candidate.type === type)
  if (spec === undefined) return
  const data = event.data
  if (spec.at === 'self') {
    if (isJsonObject(data)) visit('data', data)
    return
  }
  if (!isJsonObject(data)) return
  const held = data[spec.at]
  if (!spec.many) {
    if (isJsonObject(held)) visit(`data.${spec.at}`, held)
    return
  }
  if (!Array.isArray(held)) return
  held.forEach((message, index) => {
    if (isJsonObject(message)) visit(`data.${spec.at}[${index}]`, message)
  })
}

/**
 * Locate every message of one event whose source the admission will refuse.
 *
 * `seq` is optional because the tool can be pointed at a payload that has no
 * sequence yet; the live observer always has one, and reports it.
 * @param event - the committed event, exactly as the session holds it.
 * @returns the offences, in traversal order; empty when every source is admitted.
 */
export function scanEventSources(event: { type?: unknown, seq?: unknown, data?: unknown }): SourceOffence[] {
  const offences: SourceOffence[] = []
  const seq = typeof event.seq === 'number' ? event.seq : undefined
  const eventType = typeof event.type === 'string' ? event.type : ''
  walkMessageSlots(event, (slot, message) => {
    const source = (message as Record<string, unknown>)['source']
    const inspection = inspectSource(source)
    if (inspection.defect === undefined) return
    const fix = replacementFor(inspection, source)
    offences.push({
      eventType,
      ...seq === undefined ? {} : { seq },
      slot,
      defect: inspection.defect,
      ...inspection.kind === undefined ? {} : { kind: inspection.kind },
      ...inspection.plugin === undefined ? {} : { plugin: inspection.plugin },
      ...fix === undefined ? {} : { fix },
    })
  })
  return offences
}

/**
 * What a source the caller intends to attach will do at the write boundary.
 *
 * `parsed` is separate from `inspection` on purpose: an argument that is not
 * JSON at all is the caller's mistake, and saying so is not the same as saying
 * the harness will refuse a malformed source.
 */
export interface SourceVerdict {
  /** The argument, verbatim. */
  input: string
  /** Whether the argument parsed as JSON. */
  parsed: boolean
  /** How the admission reads the parsed value. */
  inspection: SourceInspection
  /** Whether the admission accepts it. */
  admitted: boolean
  /** The replacement to write instead, when one can be derived. */
  fix?: SourceReplacement
  /** Ordered, concrete steps. */
  advice: string[]
}

/**
 * Judge one `source` object, as JSON, before a plugin attaches it to a message.
 * @param input - the source as JSON text; `{"kind":"plugin","plugin":"x"}` is
 *   the retired shape this exists to catch.
 * @returns the verdict.
 */
export function sourceVerdict(input: string): SourceVerdict {
  let parsed: unknown
  let ok = true
  try {
    parsed = JSON.parse(input)
  } catch {
    ok = false
  }
  if (!ok) {
    return {
      input,
      parsed: false,
      inspection: {},
      admitted: false,
      advice: [
        'Pass the `source` object itself as JSON, e.g. {"kind":"plugin","plugin":"my-plugin"}.',
        'This arm judges the object the host\'s V4 admission reads, so the argument has to be that object.',
      ],
    }
  }
  const inspection = inspectSource(parsed)
  const fix = replacementFor(inspection, parsed)
  const admitted = inspection.defect === undefined
  return {
    input,
    parsed: true,
    inspection,
    admitted,
    ...fix === undefined ? {} : { fix },
    advice: adviceFor(inspection, fix),
  }
}

/**
 * The steps for one inspection. Kept beside {@link sourceVerdict} so the verdict
 * and the live observer's warning describe the same fix.
 * @param inspection - how the admission reads the source.
 * @param fix - the derived replacement, when there is one.
 * @returns ordered steps.
 */
function adviceFor(inspection: SourceInspection, fix: SourceReplacement | undefined): string[] {
  if (inspection.defect === undefined) {
    return [
      `The admission accepts this source: \`kind\` is "${inspection.kind}", which is neither empty nor the`
      + ' retired literal \'plugin\'. Nothing needs to change.',
      'Worth knowing what the rule actually is, because it is easy to overstate: the admission is NOT a'
      + ' whitelist of known producer names. Any non-empty string other than the literal \'plugin\' passes,'
      + ' which is why a new plugin never has to register its identity anywhere.',
    ]
  }
  const what: Record<SourceDefect, string> = {
    absent: 'the message carries no `source` field at all',
    'not-object': '`source` is not a JSON object',
    'kind-missing': 'the source carries no `kind` field',
    'kind-not-string': '`source.kind` is not a string',
    'kind-empty': '`source.kind` is the empty string',
    'kind-retired': '`source.kind` is the literal \'plugin\', which session format V4 retired',
  }
  const steps = [
    `Refused: ${what[inspection.defect]}.`,
    'The refusal happens at the physical row boundary, so it lands synchronously on the append that carries'
    + ' this message and the turn dies with one fixed sentence — "format v4 message requires a producer-owned'
    + ' source kind" — that names no event, no sequence and no plugin.',
  ]
  if (fix !== undefined) {
    steps.push(
      `Write ${JSON.stringify(fix.source)} instead. That kind is derived by the harness\'s own V3→V4 rewrite:`
      + ` \`producerKind\` falls back to \`plugin:\${plugin}\` for a plugin name the harness did not release,`
      + ' and the rewrite drops the `plugin` field rather than keeping both.',
      'The fallback is the rule for a name the harness did not ship. The harness also carries a table of'
      + ' released first-party identities whose kind is not that fallback; it is not exported, and if the'
      + ' name is one of those, take the kind from that table instead — this suggestion is admitted either'
      + ' way, but a migrated log of that plugin would carry the other string.',
    )
  } else if (inspection.defect === 'kind-retired') {
    steps.push(
      'The retired wrapper needs a `source.plugin` string to derive the producer kind from, and this source'
      + ' does not carry one. Name the producer: `{"kind":"my-plugin"}` is accepted for any plugin that is'
      + ' not one of the harness\'s own released identities.',
    )
  } else {
    steps.push(
      'Name the producer. The admission accepts any non-empty string other than the literal \'plugin\'; a'
      + ' third-party plugin uses its own identity, e.g. `{"kind":"my-plugin"}`.',
    )
  }
  return steps
}
