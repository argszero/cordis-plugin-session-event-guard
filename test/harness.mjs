/**
 * The integration harness: a REAL cordis context, the REAL `dsh-tools`
 * registry, the REAL JSONL persistence backend on a fresh root, and the REAL
 * `dsh-session` package the vocabulary comes from.
 *
 * What this shape proves that a stand-in cannot: the refusal this plugin is
 * about is produced by the shipped storage contract, and the acceptance of a
 * marked event is produced by the same shipped reader. A fixture that imitated
 * either would be testing this plugin against behaviour the harness does not
 * have — and the whole claim here is about what the harness does.
 *
 * The persistence backend is not stubbed because it does not need to be: it is
 * a directory of files, and a test may have one. Every arm that writes gets its
 * own root, so no arm can see another's log.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import { SESSION_FORMAT_VERSION, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { materializeCreateHeader } from '@deepseek-ai/dsh-session-persistence'
import * as plugin from '../lib/index.js'

/** The tool name the model calls. */
export const TOOL = 'session_event_guard'

/** A namespaced type no build of this line declares. */
export const EXTERNAL = 'filesnap/point'

/** A fresh directory under the OS temp root, namespaced to this suite. */
export function scratch(tag) {
  return mkdtempSync(join(tmpdir(), `seg-${tag}-`))
}

/**
 * Mount the real registry, the real backend and this plugin.
 * @param spec - `root` for the backend (a fresh one is made when absent);
 *   `backend: false` to mount the plugin with no persistence service at all;
 *   `plugin: false` to mount everything except this plugin.
 * @returns the context, the persistence service (when mounted), the log capture,
 *   and the writer used to plant sessions.
 */
export async function world(spec = {}) {
  const root = spec.root ?? scratch('world')
  const ctx = new Context()
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })
  await ctx.plugin(systemPromptPlugin, {})
  await ctx.plugin(toolsPlugin)
  if (spec.sessions === true) await ctx.plugin(SessionStore)
  if (spec.backend !== false) await ctx.plugin(Jsonl, { root, compression: 'none' })
  if (spec.plugin !== false) await ctx.plugin(plugin)
  const persistence = ctx.get('sessionPersistence')
  return { ctx, root, persistence, logged, plant: plant.bind(null, persistence) }
}

/**
 * Plant one stored session, through the two write paths the plugin is about.
 * @param persistence - the backend service.
 * @param spec - `id`, and the envelope list to append verbatim.
 * @returns the id written.
 */
export async function plant(persistence, spec) {
  const id = SessionId(spec.id)
  const handle = await persistence.create(materializeCreateHeader({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: spec.createdAt ?? Date.now(),
    cwd: process.cwd(),
    isSeeded: false,
  }))
  try {
    if (spec.events.length > 0) await handle.append(spec.events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  return id
}

/** One event as the handle seam accepts it, with the marker the caller chose. */
export function event(type, seq, data, ignorable) {
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...ignorable === true ? { ignorable: true } : {} }
}

/**
 * A declared event whose payload the shipped read path accepts.
 *
 * Not every entry in the vocabulary is usable as a fixture: the read path
 * validates payload shapes too, so `request/context` with `{}` is refused for
 * being corrupt rather than for being unknown, which would make an arm look
 * like it was measuring vocabulary when it was measuring shape. `sandbox/mode`
 * is the smallest member that survives the round trip.
 * @param seq - the sequence number.
 * @returns the event.
 */
export function declared(seq) {
  return event('sandbox/mode', seq, { mode: 'read-only' })
}

/** A fresh abort signal per call, as the tool pipeline expects. */
export const signal = () => new AbortController().signal

/**
 * Drive one call through the real registry.
 * @param ctx - the mounted context.
 * @param args - tool arguments.
 * @returns the settled result.
 */
export function call(ctx, args = {}) {
  return ctx.tools.execute({ name: TOOL, arguments: args, signal: signal() })
}

/** The canonical value of one settled result. */
export function value(result) {
  return result.value
}

/** The rendered report text of one settled result. */
export function text(result) {
  return String(result.value?.report ?? '')
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}

/** Write a file; here so specs do not each import `node:fs`. */
export { writeFileSync }

/**
 * One live session from the real store, for the arms that exercise
 * `Session.append` rather than the storage handle.
 * @param id - the session id.
 * @returns the live session.
 */
export function liveSession(id) {
  return new SessionStore(new Context()).create(SessionId(id))
}
