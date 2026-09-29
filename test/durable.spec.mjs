/**
 * The durable arms: the real JSONL backend, the real session store, and a
 * reader in a process that does not load this plugin.
 *
 * The claim under test is not "the plugin predicts a refusal" but "the refusal
 * happens". Every arm that asserts unreadability therefore asks the shipped
 * read path, and the cross-process arms ask it from a process where neither the
 * writer nor the plugin exists at all.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  LEDGER_LIMIT, LEDGER_SESSIONS, auditStore, auditStoredSession, buildExternalEvent, renderSessionAudit,
} from '../lib/index.js'
import { EXTERNAL, call, declared, event, logText, plant, text, value, world } from './harness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const READER = join(HERE, 'reader.mjs')

/** Run the out-of-process reader; never throws, so an arm can assert on the failure. */
function reader(root, id) {
  try {
    const stdout = execFileSync(process.execPath, [READER, root, id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, stdout, stderr: '' }
  } catch (error) {
    return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

describe('the write path the natural call cannot reach', () => {
  it('refuses a session whose external event carries no marker', async () => {
    const { persistence, root } = await world()
    await plant(persistence, { id: 'poisoned', events: [event(EXTERNAL, 0, { at: 1 })] })

    const audit = await auditStoredSession(persistence, SessionId('poisoned'))
    assert.equal(audit.loadable, false)
    assert.equal(audit.failure, 'refused')
    assert.equal(audit.refusalName, 'SessionFormatUnsupportedError')
    // A located refusal: the reader's own message names the type and the seq.
    assert.match(audit.refusal, /filesnap\/point/)
    assert.match(audit.refusal, /seq 0/)
    assert.match(audit.refusal, /not marked ignorable/)
  })

  it('loads the same event when the writer marked it', async () => {
    const { persistence } = await world()
    await plant(persistence, { id: 'marked', events: [event(EXTERNAL, 0, { at: 1 }, true)] })

    const audit = await auditStoredSession(persistence, SessionId('marked'))
    assert.equal(audit.loadable, true)
    assert.equal(audit.events, 1)
    assert.equal(audit.omittable, 1)
    assert.equal(audit.required, 0)
    assert.deepEqual(audit.external, [{ seq: 0, type: EXTERNAL, standing: 'omittable' }])
  })

  it('counts a log that mixes declared and marked events', async () => {
    const { persistence } = await world()
    await plant(persistence, {
      id: 'mixed',
      events: [declared(0), event(EXTERNAL, 1, { at: 1 }, true)],
    })

    const audit = await auditStoredSession(persistence, SessionId('mixed'))
    assert.equal(audit.loadable, true)
    assert.equal(audit.known, 1)
    assert.equal(audit.omittable, 1)
    assert.equal(audit.required, 0)
  })

  it('accepts the envelope buildExternalEvent produces, verbatim', async () => {
    const { persistence } = await world()
    await plant(persistence, {
      id: 'built',
      events: [buildExternalEvent({ type: EXTERNAL, data: { at: 1 }, seq: 0, at: 1 })],
    })
    const audit = await auditStoredSession(persistence, SessionId('built'))
    assert.equal(audit.loadable, true)
    assert.equal(audit.omittable, 1)
  })

  it('reports a session that does not exist without a refusal', async () => {
    const { persistence } = await world()
    const audit = await auditStoredSession(persistence, SessionId('absent'))
    assert.equal(audit.loadable, false)
    assert.equal(audit.failure, 'missing')
  })
})

describe('a read seam that fails after the session opened', () => {
  /**
   * A persistence whose `open` succeeds and whose `read` throws `throwable`.
   * Structural: `auditStoredSession` takes the service, so a backend that fails
   * mid-enumeration can be presented to it directly, without a real one that
   * only fails on the first read.
   */
  function halfOpen(throwable) {
    return {
      stat: async () => undefined,
      open: async id => ({
        header: { id },
        read: async () => { throw throwable },
        close: async () => {},
      }),
    }
  }

  it('reports an unreadable log as a truncated lower bound, and quotes what it got', async () => {
    const failure = Object.assign(new Error('backend exploded'), { name: 'BackendError' })
    const audit = await auditStoredSession(halfOpen(failure), 'half-open')

    assert.equal(audit.loadable, false)
    // Not `refused`: the storage contract did not refuse this log, the backend
    // failed, and the two must not be conflated in the report.
    assert.equal(audit.failure, 'unreadable')
    assert.equal(audit.refusalName, 'BackendError')
    assert.equal(audit.refusal, 'backend exploded')
    assert.equal(audit.truncated, true)
    const section = renderSessionAudit(audit)
    assert.match(section, /REFUSED/)
    assert.match(section, /FIRST unknown required event/)
  })

  it('carries a non-Error throw through instead of losing it', async () => {
    const audit = await auditStoredSession(halfOpen('storage said no'), 'half-open-string')

    assert.equal(audit.refusalName, 'string')
    assert.equal(audit.refusal, 'storage said no')
    assert.equal(audit.truncated, true)
  })
})

describe('a reader in its own process, without this plugin', () => {
  it('cannot open a session written without the marker', async () => {
    const { persistence, root } = await world()
    await plant(persistence, { id: 'cold-refused', events: [event(EXTERNAL, 0, { at: 1 })] })
    assert.equal(existsSync(READER), true)

    const result = reader(root, 'cold-refused')
    assert.equal(result.ok, false)
    assert.match(result.stderr, /filesnap\/point/)
    assert.match(result.stderr, /refusing to interpret the log/)
  })

  it('opens the same session written with the marker, and sees the event', async () => {
    const { persistence, root } = await world()
    await plant(persistence, { id: 'cold-marked', events: [event(EXTERNAL, 0, { at: 1 }, true)] })

    const result = reader(root, 'cold-marked')
    assert.equal(result.ok, true)
    const report = JSON.parse(result.stdout.trim())
    assert.equal(report.loaded, true)
    assert.deepEqual(report.types, [EXTERNAL])
    assert.deepEqual(report.omittable, [EXTERNAL])
  })
})

describe('the tool, through the real registry', () => {
  it('judges a type without touching storage', async () => {
    const { ctx } = await world()
    const result = await call(ctx, { type: EXTERNAL })
    const answer = value(result)
    assert.equal(answer.mode, 'preflight')
    assert.equal(answer.writeType, EXTERNAL)
    assert.equal(answer.writeVerdict, 'seam-required')
    assert.equal(answer.audited, 0)
    assert.equal(answer.total, 0)
    assert.match(text(result), /SEAM-REQUIRED/)
    // No backend was consulted, so nothing was listed and nothing is claimed.
    assert.match(text(result), /Live write boundary/)
  })

  it('declares a type this build knows safe', async () => {
    const { ctx } = await world()
    const answer = value(await call(ctx, { type: 'tool/call' }))
    assert.equal(answer.writeVerdict, 'safe')
  })

  it('audits one named session and names it when it is refused', async () => {
    const { ctx, persistence } = await world()
    await plant(persistence, { id: 'named', events: [event(EXTERNAL, 0, { at: 1 })] })
    const result = await call(ctx, { session: 'named' })
    const answer = value(result)
    assert.equal(answer.mode, 'audit')
    assert.equal(answer.audited, 1)
    assert.equal(answer.refused, 1)
    assert.deepEqual(answer.refusedSessions, ['named'])
    assert.match(text(result), /REFUSED/)
    assert.match(text(result), /filesnap\/point/)
  })

  it('sweeps the store and counts what it found', async () => {
    const { ctx, persistence } = await world()
    await plant(persistence, { id: 'ok-1', events: [declared(0)] })
    await plant(persistence, { id: 'ok-2', events: [declared(0)] })
    await plant(persistence, { id: 'bad-1', events: [event(EXTERNAL, 0, { at: 1 })] })

    const result = await call(ctx, {})
    const answer = value(result)
    assert.equal(answer.mode, 'store')
    assert.equal(answer.audited, 3)
    assert.equal(answer.total, 3)
    assert.equal(answer.refused, 1)
    assert.deepEqual(answer.refusedSessions, ['bad-1'])
  })

  it('discloses the sessions it did not open', async () => {
    const { ctx, persistence } = await world()
    for (const id of ['a', 'b', 'c']) await plant(persistence, { id, events: [declared(0)] })

    const result = await call(ctx, { limit: 1 })
    const answer = value(result)
    assert.equal(answer.audited, 1)
    assert.equal(answer.total, 3)
    // A clean sweep of one session is not a clean store, and the report says so.
    assert.match(text(result), /Coverage: 2 of 3/)
    assert.match(text(result), /does not speak/)
  })

  it('says it cannot audit when the process has no backend, and still answers the verdict', async () => {
    const { ctx } = await world({ backend: false })
    const result = await call(ctx, { type: EXTERNAL, session: 'anything' })
    const answer = value(result)
    assert.equal(answer.writeVerdict, 'seam-required')
    assert.equal(answer.audited, 0)
    assert.match(text(result), /no `sessionPersistence` service/)
  })
})

describe('the live write boundary, on a real session store', () => {
  it('records and warns when a session appends an undeclared type', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('live-poison'))
    // A declared event first, so the reported sequence is the offending event's
    // own and not the ledger's first entry.
    session.append('sandbox/mode', { mode: 'read-only' })
    session.append(EXTERNAL, { at: 1 })
    session.append(EXTERNAL, { at: 2 })

    const result = await call(ctx, { type: EXTERNAL })
    const answer = value(result)
    assert.deepEqual(answer.liveTypes, [EXTERNAL])
    assert.match(text(result), /seq 1  filesnap\/point  \(x2\)/)
    const warning = logText(logged)
    assert.match(warning, /session-event-guard/)
    assert.match(warning, /REQUIRED event/)
  })

  it('caps what one session may add to the ledger', async () => {
    const { ctx } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('live-loop'))
    for (let index = 0; index < LEDGER_LIMIT + 10; index += 1) session.append(`loop/type-${index}`, { index })

    const answer = value(await call(ctx, {}))
    // A looping writer must not be able to grow this plugin without bound.
    assert.equal(answer.liveTypes.length, LEDGER_LIMIT)
  })

  it('keeps only the newest sessions in the ledger', async () => {
    const { ctx } = await world({ sessions: true })
    for (let index = 0; index < LEDGER_SESSIONS + 5; index += 1) {
      ctx.sessions.create(SessionId(`live-${index}`)).append(EXTERNAL, { at: index })
    }

    const answer = value(await call(ctx, {}))
    assert.equal(answer.liveTypes.length, LEDGER_SESSIONS)
  })

  it('stays silent for a session that only appends declared types', async () => {
    const { ctx, logged } = await world({ sessions: true })
    const session = ctx.sessions.create(SessionId('live-clean'))
    session.append('sandbox/mode', { mode: 'read-only' })

    const answer = value(await call(ctx, {}))
    assert.deepEqual(answer.liveTypes, [])
    assert.doesNotMatch(logText(logged), /REQUIRED event/)
  })

  it('separates two sessions in the ledger', async () => {
    const { ctx } = await world({ sessions: true })
    ctx.sessions.create(SessionId('live-a')).append(EXTERNAL, { at: 1 })
    ctx.sessions.create(SessionId('live-b')).append('sandbox/mode', { mode: 'read-only' })

    const report = text(await call(ctx, { type: EXTERNAL }))
    assert.match(report, /session live-a/)
    assert.doesNotMatch(report, /session live-b/)
  })
})

describe('auditStore', () => {
  it('opens the newest sessions first and reports the store total', async () => {
    const { persistence } = await world()
    await plant(persistence, { id: 'older', createdAt: 1_000, events: [declared(0)] })
    await plant(persistence, { id: 'newer', createdAt: 2_000, events: [declared(0)] })

    const { audits, total } = await auditStore(persistence, 5)
    assert.equal(total, 2)
    assert.deepEqual(audits.map(audit => audit.id), ['newer', 'older'])
  })
})
