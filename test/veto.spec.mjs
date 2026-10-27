/**
 * The write-side veto, measured on the harness rather than restated from it.
 *
 * The claim this file exists to keep honest is the one the discussion asks
 * about: that a payload no reader would accept is **stopped at the append
 * site**, not merely reported earlier than the cold load would report it. That
 * claim has two halves, and each needs its own arm:
 *
 * 1. The harness really does let the malformed event through on its own. The
 *    control arm mounts everything except this plugin and appends the same
 *    payload — if that threw, the veto would be claiming credit for a refusal
 *    the core already performs.
 * 2. With the plugin mounted, the same append is refused and the log is left
 *    clean — proven by the next healthy append receiving sequence zero, because
 *    a sequence number is the log's own statement about how many events it
 *    holds.
 *
 * The oracle arms are the four the design was measured against before the
 * module was written, kept here so the reasoning survives the prose:
 *
 *   REFUSE   content = string   (# the reported case)
 *   ACCEPT   content = array    (healthy)
 *   REFUSE   content missing
 *   REFUSE   no id
 *   REFUSE   bad source kind
 *
 * A fifth arm covers the sentinel sequence: a legitimate replacement operation,
 * whose `startSeq` refers to an event that already exists, must not be refused
 * merely because the candidate is judged at a sequence larger than any real
 * one.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  installWriteVeto, refusalFor, SENTINEL_SEQ, SessionEventGuardError, VETO_MARK,
} from '../lib/index.js'
import { liveSession, logText, world } from './harness.mjs'

/** One message whose `content` is a string, as the reported case writes it. */
function stringContent() {
  return { id: 'm-string', role: 'user', source: { kind: 'user' }, content: 'a string, not a parts array' }
}

/** The same message with the parts array the reader requires. */
function partsContent() {
  return { id: 'm-parts', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
}

describe('the gap this plugin closes, measured without it', () => {
  it('lets a message no reader will accept reach a real session log', async () => {
    // The control: same store, same append, no plugin mounted. This is the
    // defect, and it is the reason a veto is worth installing rather than only
    // observing. If this arm ever starts throwing, the core grew the check and
    // the veto below is no longer the thing doing the work.
    const { ctx } = await world({ sessions: true, plugin: false })
    const session = ctx.sessions.create(SessionId('veto-control'))
    assert.doesNotThrow(() => session.append('user/message', stringContent(), { surfaceOp: 'append' }))
  })
})

describe('the veto, installed on the session/created hook', () => {
  it('refuses the malformed append before it lands, and leaves the log clean', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('veto-live'))
    // The hook ran: the instance's `append` carries this plugin's brand.
    assert.equal(session.append[VETO_MARK], true)

    assert.throws(
      () => session.append('user/message', stringContent(), { surfaceOp: 'append' }),
      (error) => {
        assert.equal(error instanceof SessionEventGuardError, true)
        assert.equal(error.code, 'READER_REFUSED')
        // The sentence is the reader's own, not a paraphrase of it: a refusal
        // that invents its own wording drifts from the rule it claims to apply.
        assert.match(error.message, /message has invalid content/)
        assert.match(error.message, /This event was not committed/)
        return true
      },
    )

    // The proof that the refusal happened *before* the log changed: the next
    // event committed to this session is numbered zero.
    assert.equal(session.append('user/message', partsContent(), { surfaceOp: 'append' }).seq, 0)

    const captured = logText(logged)
    assert.match(captured, /refused an append of "user\/message"/)
    assert.match(captured, /the log stays readable|stays readable by every reader/)
  })

  it('counts a repeated refusal once in the warning, keeping the reader sentence', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('veto-repeat'))
    assert.throws(() => session.append('user/message', stringContent(), { surfaceOp: 'append' }))
    assert.throws(() => session.append('user/message', stringContent(), { surfaceOp: 'append' }))
    const warnings = logged.filter(message => String(message.args[0]).includes('refused an append'))
    assert.equal(warnings.length, 1)
  })

  it('accepts what the reader accepts', async () => {
    const { ctx } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('veto-healthy'))
    assert.equal(session.append('user/message', partsContent(), { surfaceOp: 'append' }).seq, 0)
    assert.equal(session.append('sandbox/mode', { mode: 'read-only' }).seq, 1)
  })
})

describe('refusalFor, the reader asked rather than imitated', () => {
  it('refuses a non-array content', () => {
    const refusal = refusalFor('user/message', stringContent(), { surfaceOp: 'append' })
    assert.equal(refusal?.type, 'user/message')
    assert.match(refusal?.sentence ?? '', /message has invalid content/)
  })

  it('accepts an array content', () => {
    assert.equal(refusalFor('user/message', partsContent(), { surfaceOp: 'append' }), undefined)
  })

  it('refuses a message with no content at all', () => {
    const { content, ...rest } = stringContent()
    const refusal = refusalFor('user/message', rest, { surfaceOp: 'append' })
    assert.match(refusal?.sentence ?? '', /message has invalid content/)
  })

  it('refuses a message with no id', () => {
    const { id, ...rest } = partsContent()
    const refusal = refusalFor('user/message', rest, { surfaceOp: 'append' })
    assert.match(refusal?.sentence ?? '', /lacks an identified message/)
  })

  it('refuses a message whose source kind is not a non-empty string', () => {
    const refusal = refusalFor('user/message', { ...partsContent(), source: { kind: '' } }, { surfaceOp: 'append' })
    assert.match(refusal?.sentence ?? '', /message has invalid source/)
  })

  it('does not refuse what it cannot clone, leaving that verdict to append', () => {
    // A BigInt payload clones fine (`structuredClone` is not JSON) but is not a
    // message either, so a shape verdict here would be technically true and
    // practically misleading: `Session.append` refuses it with its own
    // serialization sentence in every process, and the veto's refusal text
    // claims a durability hazard that does not exist. Two owners giving one
    // event two different sentences is how a diagnostic starts lying about its
    // source, so the veto stands back whenever append will refuse anyway.
    assert.equal(refusalFor('user/message', { when: 1n }, { surfaceOp: 'append' }), undefined)
    assert.equal(refusalFor('user/message', { id: 'm', role: 'user', source: { kind: 'user' }, content: 'x', at: Number.NaN }, { surfaceOp: 'append' }), undefined)
  })

  it('does not freeze the caller\'s payload while judging it', () => {
    // `adoptSessionEvent` deep-freezes what it accepts. Judging the caller's own
    // object would leave a value this plugin was only asked about frozen — a
    // mutation the caller never requested and cannot undo.
    const payload = partsContent()
    assert.equal(refusalFor('user/message', payload, { surfaceOp: 'append' }), undefined)
    assert.equal(Object.isFrozen(payload), false)
    assert.equal(Object.isFrozen(payload.content), false)
  })

  it('judges at a sentinel sequence, so a real replacement is not refused', () => {
    // A replacement operation references events that already exist, whose
    // sequences are far below the sentinel. Guessing the next sequence instead
    // would refuse exactly this legitimate event.
    assert.equal(SENTINEL_SEQ > 4096, true)
    const refusal = refusalFor('user/message', partsContent(), {
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    })
    assert.equal(refusal, undefined)
  })
})

describe('the veto handle', () => {
  it('reports each install outcome instead of throwing into the lifecycle edge', () => {
    const session = liveSession('veto-outcome')
    assert.equal(installWriteVeto(undefined, { mode: 'refuse', onRefusal: () => {} }).outcome, 'no-append')
    assert.equal(installWriteVeto({}, { mode: 'refuse', onRefusal: () => {} }).outcome, 'no-append')
    const first = installWriteVeto(session, { mode: 'refuse', onRefusal: () => {} })
    assert.equal(first.outcome, 'patched')
    assert.equal(installWriteVeto(session, { mode: 'refuse', onRefusal: () => {} }).outcome, 'already-guarded')
    first.restore()
  })

  it('reports and commits in observe mode', () => {
    const session = liveSession('veto-observe')
    const seen = []
    const handle = installWriteVeto(session, { mode: 'observe', onRefusal: refusal => seen.push(refusal) })
    assert.equal(handle.outcome, 'patched')
    // Observe mode is the operator's escape hatch: the defect is reported and
    // the session keeps running, which is only honest if the event commits.
    assert.equal(session.append('user/message', stringContent(), { surfaceOp: 'append' }).seq, 0)
    assert.equal(seen.length, 1)
    assert.match(seen[0].sentence, /message has invalid content/)
    handle.restore()
  })

  it('stops guarding when the plugin it belongs to is disposed', async () => {
    const { ctx, fiber } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('veto-dispose'))
    assert.equal(session.append[VETO_MARK], true)
    // A guard that outlived its own plugin would keep refusing appends in a
    // process where nothing claims to guard them — and would be unfixable by
    // the operator, who has already unmounted the only thing that explains it.
    await fiber.dispose()
    assert.equal(session.append[VETO_MARK], undefined)
    assert.doesNotThrow(() => session.append('user/message', stringContent(), { surfaceOp: 'append' }))
  })

  it('restores the original append, so the shadow is reversible', () => {
    const session = liveSession('veto-restore')
    const handle = installWriteVeto(session, { mode: 'refuse', onRefusal: () => {} })
    assert.equal(handle.outcome, 'patched')
    handle.restore()
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'append'), false)
    assert.doesNotThrow(() => session.append('user/message', stringContent(), { surfaceOp: 'append' }))
  })

  it('leaves a later guard’s shadow alone when unwinding', () => {
    const session = liveSession('veto-third-party')
    const handle = installWriteVeto(session, { mode: 'refuse', onRefusal: () => {} })
    const other = function otherAppend() { return 'other' }
    session.append = other
    handle.restore()
    // Undoing this plugin must not write over state another guard owns.
    assert.equal(session.append, other)
  })
})
