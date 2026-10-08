/**
 * The second mistake, measured against the harness that makes the refusal.
 *
 * `source-kind.ts` mirrors a walk — which event types declare which message
 * slots — because that walk is what the V4 row admission runs and it is not
 * exported. A mirror can rot, so the load-bearing arm here is the first one: for
 * every slot this module claims to know, an event carrying the retired wrapper
 * in exactly that slot must be refused by the harness's own
 * `assertV4RowAdmission`, and the same event with a producer-owned kind must be
 * admitted. If a future build moves a slot, renames an event type or retires
 * the literal, the suite fails where the claim is written instead of the prose
 * quietly becoming false.
 *
 * The shapes are the awkward part and they are deliberate: several of these
 * events carry their own row checks (a positive `turn`, a `step`, a first-class
 * tool message), so a fixture that got one of those wrong would throw for the
 * wrong reason and the arm would pass while measuring nothing. Each `goodData`
 * below is asserted *admitted* first, which is what proves the `badData` refusal
 * is the source clause and not a neighbouring check.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  MESSAGE_SLOTS, inspectSource, replacementFor, scanEventSources, slotLabel, sourceVerdict, walkMessageSlots,
} from '../lib/index.js'
import { call, logText, text, value, world } from './harness.mjs'

/** The sentence the row admission throws for this clause, verbatim. */
const RETIRED_SENTENCE = 'format v4 message requires a producer-owned source kind'

/** A message whose `source` is admitted, with the role the row wants. */
const admittedMessage = (role, callId) => ({
  id: 'm1',
  role,
  content: [{ type: 'text', text: 'hi' }],
  source: callId === undefined ? { kind: 'plugin:fixture' } : { kind: 'tool', callId },
})

/** The same message, one generation behind: the anonymous wrapper V4 retired. */
const retiredMessage = (role, callId) => {
  const message = admittedMessage(role, callId)
  return { ...message, source: { ...message.source, kind: 'plugin', plugin: 'fixture' } }
}

const row = (type, data) => ({ type, seq: 0, time: 1_700_000_000_000, data })

/**
 * One declared slot, with a payload that survives every *other* row check.
 *
 * `messagePath` is the slot inside `data` the module claims, so the two can be
 * compared: `scanEventSources` must report exactly that path.
 *
 * `sentence` is the refusal the harness actually throws, and it is not the same
 * for every type: `developer/message` carries its own row check that folds the
 * source clause into one sentence of its own, so it never reaches the generic
 * one. Reading the clause out of the harness rather than assuming one wording
 * is the difference between a mirror and a guess.
 */
const SLOT_FIXTURES = [
  {
    type: 'user/message',
    messagePath: 'data',
    good: () => ({ ...admittedMessage('user') }),
    bad: () => ({ ...retiredMessage('user') }),
  },
  {
    type: 'system/message',
    messagePath: 'data.message',
    good: () => ({ turn: 1, step: 1, message: admittedMessage('system') }),
    bad: () => ({ turn: 1, step: 1, message: retiredMessage('system') }),
  },
  {
    type: 'developer/message',
    messagePath: 'data.message',
    good: () => ({ turn: 1, step: 1, message: admittedMessage('developer') }),
    bad: () => ({ turn: 1, step: 1, message: retiredMessage('developer') }),
    sentence: 'format v4 developer message requires id, role, content, and a producer-owned source',
  },
  {
    type: 'assistant/message',
    messagePath: 'data.message',
    good: () => ({ message: admittedMessage('assistant') }),
    bad: () => ({ message: retiredMessage('assistant') }),
  },
  {
    type: 'tool/result',
    messagePath: 'data.message',
    good: () => ({ message: { ...admittedMessage('tool', 'c1'), toolCallId: 'c1' } }),
    bad: () => ({ message: { ...retiredMessage('tool', 'c1'), toolCallId: 'c1' } }),
  },
  {
    type: 'agent/inbox/spliced',
    messagePath: 'data.inserted[0]',
    good: () => ({ start: 0, removedCount: 0, inserted: [admittedMessage('user')] }),
    bad: () => ({ start: 0, removedCount: 0, inserted: [retiredMessage('user')] }),
  },
  {
    type: 'session/title-llm-request',
    messagePath: 'data.messages[0]',
    good: () => ({ messages: [admittedMessage('user')] }),
    bad: () => ({ messages: [retiredMessage('user')] }),
  },
]

/** Whether the harness's own row admission refuses one event. */
function refusal(rowEvent) {
  try {
    assertV4RowAdmission(rowEvent)
    return undefined
  } catch (error) {
    return error
  }
}

describe('the declared message slots, measured against the harness', () => {
  it('covers every type the module claims, and no type it does not', () => {
    assert.deepEqual(
      MESSAGE_SLOTS.map(spec => spec.type).sort(),
      SLOT_FIXTURES.map(fixture => fixture.type).sort(),
    )
  })

  for (const fixture of SLOT_FIXTURES) {
    it(`refuses the retired wrapper in \`${fixture.type}\` at ${fixture.messagePath}`, () => {
      // The control first: a payload that is admitted proves the refusal below
      // is the source clause rather than a neighbouring row check.
      assert.equal(refusal(row(fixture.type, fixture.good())), undefined,
        `${fixture.type} fixture is not otherwise admissible, so this arm would measure the wrong clause`)
      const refused = refusal(row(fixture.type, fixture.bad()))
      assert.notEqual(refused, undefined, `${fixture.type} admitted a retired source`)
      assert.equal(refused.name, 'SessionFormatError')
      assert.equal(refused.message, fixture.sentence ?? RETIRED_SENTENCE)
    })

    it(`locates that refusal at \`${fixture.messagePath}\``, () => {
      assert.deepEqual(scanEventSources(row(fixture.type, fixture.good())), [])
      const offences = scanEventSources(row(fixture.type, fixture.bad()))
      assert.equal(offences.length, 1)
      assert.equal(offences[0].eventType, fixture.type)
      assert.equal(offences[0].seq, 0)
      assert.equal(offences[0].slot, fixture.messagePath)
      assert.equal(offences[0].defect, 'kind-retired')
      assert.equal(offences[0].plugin, 'fixture')
      assert.equal(offences[0].fix.kind, 'plugin:fixture')
      assert.equal('plugin' in offences[0].fix.source, false)
    })

    it(`names the slot the way the report prints it for \`${fixture.type}\``, () => {
      const spec = MESSAGE_SLOTS.find(candidate => candidate.type === fixture.type)
      // `slotLabel` is what the tool's help text and the prose use; the walk
      // reports the concrete index, which is the same path one level deeper.
      // The `[]` suffix marks a slot that holds several messages, so it stands
      // for the index the walk prints and is not itself a prefix.
      const label = slotLabel(spec).replace(/\[\]$/, '')
      assert.equal(fixture.messagePath.startsWith(label), true,
        `${label} is not a prefix of ${fixture.messagePath}`)
      assert.equal(spec.many, fixture.messagePath.includes('['))
    })
  }

  it('does not refuse a message the harness admits, whatever kind it carries', () => {
    // The admission is not a whitelist: any non-empty kind other than the
    // literal passes, which is the correction the discussion needed.
    for (const kind of ['plugin:fixture', 'hindsight-memory', 'a', 'whatever']) {
      const event = row('user/message', { ...admittedMessage('user'), source: { kind } })
      assert.equal(refusal(event), undefined, `harness refused kind ${JSON.stringify(kind)}`)
      assert.deepEqual(scanEventSources(event), [])
    }
  })
})

describe('inspectSource: the four clauses, in the admission\'s order', () => {
  it('reads an absent source as absent, not as a kind defect', () => {
    assert.deepEqual(inspectSource(undefined), { defect: 'absent' })
  })

  it('refuses a non-object source', () => {
    for (const source of [null, 'plugin:x', 7, ['plugin:x'], true]) {
      assert.deepEqual(inspectSource(source), { defect: 'not-object' })
    }
  })

  it('refuses a missing, non-string and empty kind, carrying the plugin name either way', () => {
    assert.deepEqual(inspectSource({ plugin: 'p' }), { defect: 'kind-missing', plugin: 'p' })
    assert.deepEqual(inspectSource({ kind: 7, plugin: 'p' }), { defect: 'kind-not-string', plugin: 'p' })
    assert.deepEqual(inspectSource({ kind: '', plugin: 'p' }), { defect: 'kind-empty', kind: '', plugin: 'p' })
  })

  it('carries no plugin field when the plugin is not a string', () => {
    assert.deepEqual(inspectSource({ kind: 'plugin:fast', plugin: 7 }), { kind: 'plugin:fast' })
  })

  it('names the literal as retired, and nothing else', () => {
    assert.deepEqual(inspectSource({ kind: 'plugin', plugin: 'p' }), { defect: 'kind-retired', kind: 'plugin', plugin: 'p' })
    assert.deepEqual(inspectSource({ kind: 'plugin', plugin: 'p', form: 'snapshot' }),
      { defect: 'kind-retired', kind: 'plugin', plugin: 'p' })
    assert.deepEqual(inspectSource({ kind: 'plugin:' }), { kind: 'plugin:' })
    assert.deepEqual(inspectSource({ kind: 'Plugin' }), { kind: 'Plugin' })
  })
})

describe('replacementFor: the rule the harness\'s own rewrite uses', () => {
  it('derives the fallback and drops the retired wrapper', () => {
    const source = { kind: 'plugin', plugin: 'hindsight-memory', form: 'snapshot' }
    const fix = replacementFor(inspectSource(source), source)
    assert.equal(fix.kind, 'plugin:hindsight-memory')
    assert.equal(fix.derived, 'plugin-prefix')
    // The harness's `rewritePluginSource` drops `plugin` rather than keeping
    // both; a suggestion that kept it would be the divergent shape the plugin
    // exists to prevent.
    assert.deepEqual(fix.source, { kind: 'plugin:hindsight-memory', form: 'snapshot' })
  })

  it('is undefined for every clause that is not the retired literal', () => {
    for (const source of [undefined, 'x', { plugin: 'p' }, { kind: 7 }, { kind: '' }, { kind: 'plugin:ok' }]) {
      assert.equal(replacementFor(inspectSource(source), source), undefined)
    }
  })

  it('is undefined for a retired wrapper with no name to derive from', () => {
    assert.equal(replacementFor(inspectSource({ kind: 'plugin' }), { kind: 'plugin' }), undefined)
    assert.equal(replacementFor(inspectSource({ kind: 'plugin', plugin: '' }), { kind: 'plugin', plugin: '' }), undefined)
  })

  it('defaults the carried fields rather than requiring the source object', () => {
    assert.deepEqual(replacementFor(inspectSource({ kind: 'plugin', plugin: 'p' })).source, { kind: 'plugin:p' })
  })
})

describe('walkMessageSlots: it locates, it does not invent', () => {
  it('visits only the messages that are present', () => {
    const seen = []
    walkMessageSlots({ type: 'user/message', data: undefined }, (slot, message) => seen.push([slot, message]))
    walkMessageSlots({ type: 'system/message', data: {} }, (slot, message) => seen.push([slot, message]))
    walkMessageSlots({ type: 'agent/inbox/spliced', data: { inserted: 'not-an-array' } }, (slot, m) => seen.push([slot, m]))
    assert.deepEqual(seen, [])
  })

  it('skips entries that are not objects instead of reporting them as source defects', () => {
    // Reporting a source clause for a message that is not an object would be
    // claiming a refusal the harness makes with a different sentence
    // (`… requires a message array`).
    const seen = []
    walkMessageSlots({ type: 'agent/inbox/spliced', data: { inserted: [null, 'x', { source: { kind: 'plugin' } }] } },
      (slot, message) => seen.push([slot, message]))
    assert.deepEqual(seen.map(([slot]) => slot), ['data.inserted[2]'])
    assert.deepEqual(scanEventSources({
      type: 'agent/inbox/spliced', seq: 3, data: { inserted: [null, 'x', { source: { kind: 'plugin' } }] },
    }).map(offence => offence.slot), ['data.inserted[2]'])
  })

  it('ignores an event type no slot spec declares, and an event with no type', () => {
    assert.deepEqual(scanEventSources({ type: 'request/context', seq: 0, data: {} }), [])
    assert.deepEqual(scanEventSources({ data: { source: { kind: 'plugin' } } }), [])
  })

  it('omits the sequence when the event carries none', () => {
    const [offence] = scanEventSources({ type: 'user/message', data: retiredMessage('user') })
    assert.equal(offence.seq, undefined)
    assert.equal('seq' in offence, false)
  })

  it('finds both messages when one event declares two offending slots', () => {
    const offences = scanEventSources({
      type: 'agent/inbox/spliced',
      seq: 4,
      data: { start: 1, removedCount: 1, inserted: [retiredMessage('user'), retiredMessage('user')] },
    })
    assert.deepEqual(offences.map(offence => offence.slot), ['data.inserted[0]', 'data.inserted[1]'])
  })
})

describe('sourceVerdict: the pre-attach arm', () => {
  it('says the argument did not parse, and does not blame the harness for it', () => {
    const verdict = sourceVerdict('nope')
    assert.equal(verdict.parsed, false)
    assert.equal(verdict.admitted, false)
    assert.deepEqual(verdict.inspection, {})
    assert.equal(verdict.fix, undefined)
    assert.equal(verdict.advice[0].includes('JSON'), true)
  })

  it('admits a producer-owned kind and corrects the whitelist reading', () => {
    const verdict = sourceVerdict('{"kind":"hindsight-memory"}')
    assert.equal(verdict.parsed, true)
    assert.equal(verdict.admitted, true)
    assert.equal(verdict.fix, undefined)
    assert.equal(verdict.advice.join(' ').includes('NOT a whitelist'), true)
  })

  it('refuses the retired wrapper and hands over the replacement', () => {
    const verdict = sourceVerdict('{"kind":"plugin","plugin":"hindsight-memory"}')
    assert.equal(verdict.admitted, false)
    assert.equal(verdict.inspection.defect, 'kind-retired')
    assert.deepEqual(verdict.fix.source, { kind: 'plugin:hindsight-memory' })
    assert.equal(verdict.advice.join(' ').includes('plugin:hindsight-memory'), true)
  })

  it('tells a nameless retired wrapper to name the producer', () => {
    const verdict = sourceVerdict('{"kind":"plugin"}')
    assert.equal(verdict.admitted, false)
    assert.equal(verdict.fix, undefined)
    assert.equal(verdict.advice.join(' ').includes('Name the producer'), true)
  })

  it('names the missing kind as the missing kind', () => {
    const verdict = sourceVerdict('{"plugin":"p"}')
    assert.equal(verdict.inspection.defect, 'kind-missing')
    assert.equal(verdict.advice.join(' ').includes('carries no `kind` field'), true)
  })
})

describe('the live observer, through the real registry', () => {
  it('reports a retired source the moment the session commits it', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('live-retired'))
    // The append succeeds: this is the whole point. The event reaches the live
    // log, and only the durable write refuses it — later, elsewhere.
    assert.doesNotThrow(() => session.append('user/message', retiredMessage('user'), { surfaceOp: 'append' }))

    const captured = logText(logged)
    assert.equal(captured.includes('session-event-guard:'), true, captured)
    assert.equal(captured.includes('user/message at seq 0 slot data'), true, captured)
    assert.equal(captured.includes('written by plugin "fixture"'), true, captured)
    assert.equal(captured.includes('kind-retired'), true, captured)
    assert.equal(captured.includes('{"kind":"plugin:fixture"}'), true, captured)
  })

  it('counts a repeat without logging it twice', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('live-repeat'))
    session.append('user/message', retiredMessage('user'), { surfaceOp: 'append' })
    session.append('user/message', retiredMessage('user'), { surfaceOp: 'append' })
    const warnings = logged.filter(message => String(message.args[0]).includes('committed user/message'))
    assert.equal(warnings.length, 1)
    const answer = value(await call(ctx, {}))
    assert.deepEqual(answer.liveSources, ['user/message@0:data:kind-retired'])
    assert.equal(text(await call(ctx, {})).includes('(x2)'), true)
  })

  it('says nothing when every source is producer-owned', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('live-clean'))
    session.append('user/message', admittedMessage('user'), { surfaceOp: 'append' })
    assert.equal(logText(logged).includes('session-event-guard:'), false)
    const answer = value(await call(ctx, {}))
    assert.deepEqual(answer.liveSources, [])
    assert.equal(text(await call(ctx, {})).includes('Live source admission — nothing to report.'), true)
  })

  it('judges a source handed to the tool, without needing a session', async () => {
    const { ctx } = await world({ sessions: true })
    const answer = value(await call(ctx, { source: '{"kind":"plugin","plugin":"hindsight-memory"}' }))
    assert.equal(answer.sourceAdmitted, false)
    assert.equal(answer.sourceDefect, 'kind-retired')
    assert.equal(answer.sourceKind, 'plugin')
    const refused = text(await call(ctx, { source: '{"kind":"plugin","plugin":"hindsight-memory"}' }))
    assert.equal(refused.includes('Verdict: REFUSED'), true, refused)
    assert.equal(refused.includes('Write instead: {"kind":"plugin:hindsight-memory"}'), true, refused)
    const report = text(await call(ctx, { source: '{"kind":"plugin:ok"}' }))
    assert.equal(report.includes('Verdict: ADMITTED'), true)
    assert.equal(report.includes('source.kind'), true)
  })
})
