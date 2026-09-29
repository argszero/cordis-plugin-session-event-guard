/**
 * The envelope an external plugin may write to a session log.
 *
 * The natural call cannot produce this object. `Session.append` freezes
 * `{ type, seq, time, data, ...surfaceMetadata }` itself and offers no way to
 * set the marker, so a session log can only carry an *omittable* external
 * event if the writer builds the envelope and hands it to the handle seam
 * (`ctx.sessionPersistence.open(id, 'write')` → `handle.append([event])`).
 *
 * This module builds that object and refuses the three mistakes a hand-rolled
 * one makes. Each refusal is a refusal at the write boundary, which is the
 * point: the alternative is a log that reads back fine in this process and is
 * refused by the next one.
 *
 * @module @argszero/cordis-plugin-session-event-guard/envelope
 */

import { KNOWN_EVENT_TYPES } from './vocabulary.ts'

/** A refusal this package raises before a bad event can reach storage. */
export class SessionEventGuardError extends Error {
  /** Stable machine-routable code. */
  readonly code: 'KNOWN_TYPE' | 'PREFIXED_TYPE' | 'UNNAMESPACED_TYPE' | 'NOT_JSON'
  constructor(code: SessionEventGuardError['code'], message: string) {
    super(message)
    this.name = 'SessionEventGuardError'
    this.code = code
  }
}

/** The envelope fields a caller supplies. */
export interface ExternalEventInput {
  /** Type name, namespaced by the plugin, e.g. `filesnap/point`. */
  type: string
  /** Payload; must survive a JSON round trip without loss. */
  data: unknown
  /**
   * The sequence number. A handle's first appended event MUST carry the stored
   * next-seq (`SessionHandle.append`), and committed events are never
   * rewritten, so this is read from the handle rather than invented.
   */
  seq: number
  /** Creation time; defaults to `Date.now()`, injectable for determinism. */
  at?: number
}

/** One stored event, as the handle seam accepts it. */
export interface ExternalEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable: true
}

/**
 * Build one omittable external event.
 *
 * The prefix rule is not cosmetic: the v3→v4 format migration rewrites an
 * unknown omittable type to `` `plugin:${type}` ``. Prefixing by hand stores
 * `plugin:plugin:<type>`, which no later reader or migration recognises.
 *
 * @param input - the caller's fields.
 * @returns the envelope, ready for `handle.append([event])`.
 * @throws {SessionEventGuardError} for a type this build already declares
 *   (write it with `Session.append` instead), a `plugin:`-prefixed type, an
 *   unnamespaced type, or a payload that is not lossless JSON.
 */
export function buildExternalEvent(input: ExternalEventInput): ExternalEvent {
  const { type } = input
  if (KNOWN_EVENT_TYPES.has(type)) {
    throw new SessionEventGuardError(
      'KNOWN_TYPE',
      `session-event-guard: "${type}" is declared by this build's generated vocabulary, so it is a KNOWN`
      + ' event and marking it omittable would tell readers they may skip something they interpret.'
      + ' Write it with session.append(type, data); the handle seam is for out-of-repo types only.',
    )
  }
  if (type.startsWith('plugin:')) {
    throw new SessionEventGuardError(
      'PREFIXED_TYPE',
      `session-event-guard: "${type}" already carries the \`plugin:\` prefix. That prefix is added by the`
      + ' v3→v4 format migration to unknown omittable types, so storing it prefixed yields'
      + ` \`plugin:${type}\`. Use the bare namespaced type instead.`,
    )
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(type)) {
    throw new SessionEventGuardError(
      'UNNAMESPACED_TYPE',
      `session-event-guard: "${type}" is not namespaced. Use "<namespace>/<name>", where the namespace`
      + ' identifies the writing plugin, so two plugins cannot collide on one type name.',
    )
  }
  const reason = jsonDefect(input.data)
  if (reason !== undefined) {
    throw new SessionEventGuardError(
      'NOT_JSON',
      `session-event-guard: the payload of "${type}" is not lossless JSON data — ${reason}.`
      + ' The log is the durable source of truth and a backend rejects such a value at its write boundary;'
      + ' serializing it here would store something different from what was passed.',
    )
  }
  return { type, seq: input.seq, time: input.at ?? Date.now(), data: input.data, ignorable: true }
}

/**
 * The same rules `snapshotJsonValue` applies in the harness: a value that does
 * not survive a JSON round trip unchanged may not enter the log.
 * @param value - candidate payload.
 * @returns the first defect, or `undefined` when the value is lossless JSON.
 */
function jsonDefect(value: unknown): string | undefined {
  const seen = new Set<object>()
  const pending: { node: unknown; path: string }[] = [{ node: value, path: 'data' }]
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, path } = next
    if (node === null) continue
    switch (typeof node) {
      case 'boolean':
      case 'string':
        continue
      case 'number':
        if (!Number.isFinite(node)) return `${path} is a non-finite number`
        if (Object.is(node, -0)) return `${path} is negative zero`
        continue
      case 'object':
        break
      default:
        return `${path} is a ${typeof node}`
    }
    if (seen.has(node)) return `${path} is a circular reference`
    seen.add(node)
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(node, index)) return `${path}[${index}] is a hole in a sparse array`
        pending.push({ node: node[index], path: `${path}[${index}]` })
      }
      continue
    }
    const proto: unknown = Object.getPrototypeOf(node)
    if (proto !== null && Object.getPrototypeOf(proto) !== null) {
      return `${path} is an exotic object (${(node as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'})`
    }
    for (const [key, child] of Object.entries(node)) pending.push({ node: child, path: `${path}.${key}` })
  }
  return undefined
}
