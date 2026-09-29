/**
 * The claims this package makes *about the harness*, measured against the
 * harness rather than restated from reading it.
 *
 * Every arm here exists because the plugin's user-facing text asserts it. If a
 * future build changes one of these, the suite says so in the place the prose
 * is written from, instead of the prose quietly becoming false.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { RELEASED_V3_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { EXTERNAL, liveSession } from './harness.mjs'

describe('Session.append, on a real session', () => {
  it('accepts an event type no build of this line declares', () => {
    // The heart of the problem: the write boundary does NOT refuse an unknown
    // type. Nothing warns, nothing throws — the failure is deferred to the next
    // cold load, in a process that may not even be this one.
    const session = liveSession('contract-accepts')
    assert.equal(KNOWN_SESSION_EVENT_TYPES.has(EXTERNAL), false)
    assert.doesNotThrow(() => session.append(EXTERNAL, { at: 1 }))
  })

  it('freezes an envelope with no `ignorable` field and no way to add one', () => {
    const session = liveSession('contract-envelope')
    const event = session.append(EXTERNAL, { at: 1 })
    assert.deepEqual(Object.keys(event).sort(), ['data', 'seq', 'time', 'type'])
    assert.equal(event.ignorable, undefined)
    assert.equal('ignorable' in event, false)
  })

  it('produces the same shape for a declared type', () => {
    const session = liveSession('contract-known')
    const event = session.append('request/context', {})
    assert.equal(event.ignorable, undefined)
  })

  it('numbers events from zero and hands back the logged value', () => {
    const session = liveSession('contract-seq')
    assert.equal(session.append(EXTERNAL, { at: 1 }).seq, 0)
    assert.equal(session.append(EXTERNAL, { at: 2 }).seq, 1)
  })
})

describe('the v3→v4 migration the prefix advice cites', () => {
  it('does not list the external type, so its rewrite condition holds', () => {
    // `namespaceV3OpaqueEvent` rewrites `` { ...event, type: `plugin:${event.type}`, ignorable: true } ``
    // exactly when the event is marked and its type is NOT in this set. The
    // function is not exported from the package root, so the condition is what
    // can be measured from outside; the README says so rather than implying the
    // rewrite itself was executed here.
    assert.equal(RELEASED_V3_EVENT_TYPES.has(EXTERNAL), false)
  })

  it('carries no `plugin:` entry, so pre-prefixing is not idempotent', () => {
    const prefixed = [...RELEASED_V3_EVENT_TYPES].filter(type => type.startsWith('plugin:'))
    assert.deepEqual(prefixed, [])
  })
})
