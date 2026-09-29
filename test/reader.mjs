/**
 * A reader in a process of its own, deliberately not loading this plugin.
 *
 * This is the scenario the whole package is about, executed rather than
 * described: the writer is gone, the plugin is gone, and the only thing left is
 * a directory of stored events and the harness's own read path. It imports the
 * persistence backend and `dsh-session` and nothing else — in particular it
 * does not import `../lib/index.js`, so a log this process can read is a log a
 * reader without the plugin can read.
 *
 * ```sh
 * node test/reader.mjs <backend root> <session id>
 * ```
 *
 * Exit 0 with one JSON line on stdout when the log loaded; a non-zero exit with
 * the reader's own message on stderr when it did not.
 */

import { Context } from '@deepseek-ai/cordis'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'

const [root, id] = process.argv.slice(2)
if (root === undefined || id === undefined) {
  process.stderr.write('usage: node reader.mjs <backend root> <session id>\n')
  process.exit(2)
}

const ctx = new Context()
await ctx.plugin(Jsonl, { root, compression: 'none' })
const persistence = ctx.get('sessionPersistence')
const handle = await persistence.open(SessionId(id), 'read')
try {
  const { events } = await handle.read()
  process.stdout.write(`${JSON.stringify({
    loaded: true,
    events: events.length,
    types: events.map(event => event.type),
    omittable: events.filter(event => event.ignorable === true).map(event => event.type),
  })}\n`)
} finally {
  await handle.close()
}
