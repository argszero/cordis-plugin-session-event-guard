/**
 * The write-boundary verdict and the envelope builder, as pure units.
 *
 * These arms do not need a backend: they are the answer the plugin gives
 * *before* anything is written, and the refusals it raises instead of letting a
 * hand-rolled envelope reach storage.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KNOWN_EVENT_TYPES, SessionEventGuardError, buildExternalEvent, renderWriteVerdict, standingOf,
  vocabularyReport, writeVerdict,
} from '../lib/index.js'
import { EXTERNAL } from './harness.mjs'

describe('standingOf', () => {
  it('calls a declared type known', () => {
    assert.equal(standingOf('user/message'), 'known')
    assert.equal(KNOWN_EVENT_TYPES.has('user/message'), true)
  })

  it('calls an undeclared type required when the envelope has no marker', () => {
    assert.equal(standingOf(EXTERNAL), 'required')
    assert.equal(standingOf(EXTERNAL, undefined), 'required')
    assert.equal(standingOf(EXTERNAL, false), 'required')
    assert.equal(standingOf(EXTERNAL, 'true'), 'required')
  })

  it('calls an undeclared type omittable only on an exact `true`', () => {
    assert.equal(standingOf(EXTERNAL, true), 'omittable')
  })

  it('never lets a marker downgrade a declared type', () => {
    assert.equal(standingOf('user/message', true), 'known')
  })

  it('reports which build answered', () => {
    const report = vocabularyReport()
    assert.equal(report.size, KNOWN_EVENT_TYPES.size)
    assert.match(report.version, /^\d+\.\d+\.\d+/)
  })
})

describe('writeVerdict', () => {
  it('declares an out-of-repo type seam-required, on both paths', () => {
    const verdict = writeVerdict(EXTERNAL)
    assert.equal(verdict.inVocabulary, false)
    assert.equal(verdict.natural, 'required')
    assert.equal(verdict.seam, 'omittable')
    assert.equal(verdict.verdict, 'seam-required')
  })

  it('models the append limitation as a value, not as prose', () => {
    // The one fact the whole package rests on. `false` is not a guess about the
    // current build: `Session.append` has no parameter that could make it true,
    // and `contract.spec.mjs` measures the same claim against the real call.
    assert.equal(writeVerdict(EXTERNAL).appendCanMarkOmittable, false)
  })

  it('names the seam and the prefix trap when the type is external', () => {
    const advice = writeVerdict(EXTERNAL).advice.join('\n')
    assert.match(advice, /sessionPersistence\.open/)
    assert.match(advice, /buildExternalEvent/)
    assert.match(advice, /plugin:/)
  })

  it('declares a type this build knows safe, and says why', () => {
    const verdict = writeVerdict('user/message')
    assert.equal(verdict.inVocabulary, true)
    assert.equal(verdict.natural, 'known')
    assert.equal(verdict.verdict, 'safe')
    assert.equal(verdict.advice.length, 1)
    // A property of the call, not of the type: it holds on both verdicts.
    assert.equal(verdict.appendCanMarkOmittable, false)
  })

  it('does not decide by shape: a slashed name this build declares is still known', () => {
    // `tool/call` looks exactly like an external plugin type and is core.
    assert.equal(writeVerdict('tool/call').verdict, 'safe')
  })
})

describe('renderWriteVerdict', () => {
  it('states both write paths as rows, and the append limitation as a measured value', () => {
    // The rows are the artifact a plugin author reads, and the two paths must not
    // be able to swap places in it: `natural` is the envelope `session.append`
    // builds (required), `seam` is the marked one (omittable).
    const text = renderWriteVerdict(writeVerdict(EXTERNAL), vocabularyReport())
    assert.match(text, /envelope from session\.append\s+\.+\s+required/)
    assert.match(text, /append can set `ignorable`\s+\.+\s+false/)
    // (the longest label fills the row exactly, so no dot leader on that one)
    assert.match(text, /envelope through the handle seam\s+\.*\s*omittable/)
  })

  it('says SAFE for a declared type, and does not describe a seam it does not need', () => {
    const text = renderWriteVerdict(writeVerdict('tool/call'), vocabularyReport())
    assert.match(text, /Verdict: SAFE/)
    assert.doesNotMatch(text, /SEAM-REQUIRED/)
  })
})

describe('buildExternalEvent', () => {
  it('returns the envelope the handle seam accepts', () => {
    const event = buildExternalEvent({ type: EXTERNAL, data: { at: 3 }, seq: 7, at: 1_700_000_000_000 })
    assert.deepEqual(event, {
      type: EXTERNAL, seq: 7, time: 1_700_000_000_000, data: { at: 3 }, ignorable: true,
    })
  })

  it('defaults the time rather than requiring it', () => {
    const before = Date.now()
    const event = buildExternalEvent({ type: EXTERNAL, data: null, seq: 0 })
    assert.ok(event.time >= before && event.time <= Date.now())
  })

  it('refuses a type this build already declares', () => {
    assert.throws(
      () => buildExternalEvent({ type: 'user/message', data: {}, seq: 0 }),
      error => error instanceof SessionEventGuardError && error.code === 'KNOWN_TYPE',
    )
  })

  it('refuses a pre-prefixed type instead of storing a double prefix', () => {
    assert.throws(
      () => buildExternalEvent({ type: `plugin:${EXTERNAL}`, data: {}, seq: 0 }),
      error => error instanceof SessionEventGuardError && error.code === 'PREFIXED_TYPE',
    )
  })

  it('refuses an unnamespaced type', () => {
    for (const type of ['point', '/point', 'filesnap/', 'filesnap point']) {
      assert.throws(
        () => buildExternalEvent({ type, data: {}, seq: 0 }),
        error => error instanceof SessionEventGuardError && error.code === 'UNNAMESPACED_TYPE',
        `expected "${type}" to be refused`,
      )
    }
  })

  it('accepts a nested namespace', () => {
    assert.equal(buildExternalEvent({ type: 'filesnap/point/created', data: {}, seq: 0 }).ignorable, true)
  })

  it('refuses payloads that would not survive a JSON round trip', () => {
    const cases = [
      ['undefined', undefined],
      ['a function', () => {}],
      ['a symbol', Symbol('x')],
      ['a bigint', 1n],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['negative zero', -0],
      ['a Date', new Date()],
      ['a Map', new Map()],
      ['a nested undefined', { a: undefined }],
    ]
    for (const [label, data] of cases) {
      assert.throws(
        () => buildExternalEvent({ type: EXTERNAL, data, seq: 0 }),
        error => error instanceof SessionEventGuardError && error.code === 'NOT_JSON',
        `expected ${label} to be refused`,
      )
    }
  })

  it('refuses a cycle and a sparse array', () => {
    const cyclic = { a: 1 }
    cyclic.self = cyclic
    assert.throws(() => buildExternalEvent({ type: EXTERNAL, data: cyclic, seq: 0 }),
      error => error.code === 'NOT_JSON' && /circular reference/.test(error.message))
    const sparse = [1, , 3]
    // The reason matters: without the hole check the walk still refuses, because
    // reading a hole yields `undefined`, and the refusal would name a value that
    // is not in the payload rather than the hole that is.
    assert.throws(() => buildExternalEvent({ type: EXTERNAL, data: sparse, seq: 0 }),
      error => error.code === 'NOT_JSON' && /hole in a sparse array/.test(error.message))
  })

  it('accepts every shape a log may legitimately carry', () => {
    const data = { nested: { list: [1, 'two', null, true], float: 1.5 }, empty: {} }
    assert.deepEqual(buildExternalEvent({ type: EXTERNAL, data, seq: 0 }).data, data)
    assert.equal(buildExternalEvent({ type: EXTERNAL, data: null, seq: 0 }).data, null)
    assert.deepEqual(buildExternalEvent({ type: EXTERNAL, data: [0], seq: 0 }).data, [0])
  })

  it('names the offending path, so the refusal locates itself', () => {
    assert.throws(
      () => buildExternalEvent({ type: EXTERNAL, data: { a: { b: Number.NaN } }, seq: 0 }),
      error => /data\.a\.b/.test(error.message),
    )
  })
})
