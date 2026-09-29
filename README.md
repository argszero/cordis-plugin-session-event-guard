# @argszero/cordis-plugin-session-event-guard

A session log has to stay readable by builds that do not load the plugin that wrote it. One write
path silently breaks that, and the break is deferred to a later process:

```
session "<id>" contains event type "filesnap/point" (seq 0) unknown to this harness and not marked
ignorable; refusing to interpret the log — it was likely written by a newer harness
```

This plugin diagnoses that mistake at the write boundary, audits stored sessions for it through the
same read seam a restart uses, and builds the envelope the public handle seam accepts.

Origin: [deepseek-ai/deepseek-harness discussion #8233](https://github.com/deepseek-ai/deepseek-harness/discussions/8233),
from the author of `dsh-filesnap`, which reported it after hitting it in practice.

Mount it:

```yaml
- id: session-event-guard
  name: '@argszero/cordis-plugin-session-event-guard'
```

Published as `@argszero/cordis-plugin-session-event-guard@0.1.0`.

## The gap, exactly

Two calls write an event, and they do not have the same powers.

**`Session.append(type, data)`** — `packages/core/session/src/index.ts:722`. It builds and freezes
the envelope itself:

```ts
const event = deepFreeze({
  type, seq: SessionSeq(this.log.length), time: Date.now(), data: dataSnapshot,
  ...(surfaceMetadataSnapshot as { surfaceOp?: unknown; sourceEventSeqs?: unknown }),
} as unknown as SessionEvent<T>)
```

There is no `ignorable` field and no parameter that could add one. **Every event written this way is
a required event.** A plugin cannot opt out — it is a property of the call.

**`SessionHandle.append(events)`** — `packages/session/session-persistence/src/handle.ts:97`. It takes
caller-owned envelopes and does not strip a marker the caller set. This is the seam that can produce
an omittable event, and it is public: `message-feedback` already reaches it from outside core
(`packages/feedback/message-feedback/src/index.ts:267`, via
`ctx.sessionPersistence.open(id, 'write')`).

Now put them together with the read path. `validateStoredEvents`
(`packages/session/session-persistence/src/storage-contract.ts:71`) refuses any event whose type is
outside the build's vocabulary **unless** the envelope carries `ignorable: true`. That vocabulary is
generated from the event types declared *in the harness repository*
(`packages/core/session/src/known-event-types.ts`), and its own doc comment says out-of-repo plugin
events are outside the set **by construction**.

So: a plugin may declaration-merge `SessionEventMap`, `session.append('filesnap/point', data)`
compiles, and the running process works. The write is a required event. The next process to load that
log — including the same harness after the plugin is uninstalled — refuses the whole session rather
than silently dropping an event it cannot interpret. The failure distance is the whole point: nothing
is wrong until a cold load, possibly days later, possibly on someone else's machine.

The mechanism to avoid it exists and is documented; what was missing is (a) that `Session.append`
cannot reach it, stated where a plugin author will look, and (b) a refusal at the write boundary
instead of at restart. This package supplies both, from outside core, over public seams only.

## What it provides

- **`session_event_guard` tool** — a write-boundary verdict for a type name (`type`), an audit of one
  stored session (`session`), or a sweep of the store (neither).
- **A live observer** on `session/event`, so a session that appends an undeclared type is reported in
  the process that did it, with the type and the sequence.
- **`buildExternalEvent({ type, data, seq, at? })`** — the envelope the handle seam accepts, with the
  four refusals a hand-rolled one gets wrong.

### The verdict

```
Session event write audit — "filesnap/point"

Verdict: SEAM-REQUIRED — written with session.append this type makes the session unreadable
to a reader that does not load the writing plugin.

  vocabulary .................... 59 event types from @deepseek-ai/dsh-session@0.1.7-rc.2
  in the vocabulary ............. no
  envelope from session.append .. required
  append can set `ignorable` .... false
  envelope through the handle seam omittable
```

### The audit

The audit does not predict the reader's answer, it asks for it: it opens the stored session through
`sessionPersistence` — the same service, the same validated read path, the same fail-closed contract a
restart uses — and reports what happened. A refusal is quoted **verbatim**, because that message
already names the type and the sequence the reader stopped at.

### The helper

```js
import { buildExternalEvent } from '@argszero/cordis-plugin-session-event-guard'

const handle = await ctx.sessionPersistence.open(sessionId, 'write')
await handle.append([buildExternalEvent({ type: 'filesnap/point', data: { at: 1 }, seq: 0 })])
await handle.flush()
```

`seq` must be the stored next-seq (`SessionHandle.append`: "the first event's `seq` MUST equal the
stored next-seq"). The helper refuses a type the vocabulary already declares (marking a *known* event
omittable tells readers they may skip something they interpret), a `plugin:`-prefixed type, an
unnamespaced type, and any payload that would not survive a JSON round trip — each with the offending
path named.

Do **not** prefix the type with `plugin:` yourself. The v3→v4 migration rewrites an unknown omittable
type to `` `plugin:${type}` `` (`packages/session/session-format-v3-to-v4/src/extension-identities.ts`,
`namespaceV3OpaqueEvent`), so pre-prefixing stores `plugin:plugin:<type>`. That function is not
exported from the package root, so the suite measures the condition it tests
(`RELEASED_V3_EVENT_TYPES` contains neither the type nor any `plugin:` entry) rather than the rewrite.

## What it does not do, and what it cannot see

- **It does not write to any session log.** Not its own events, not yours. The helper builds an object;
  the caller appends it.
- **It does not change core.** No event type is registered, no vocabulary is extended, and no
  validation is relaxed. The verdict is computed from the vocabulary plus the `session.append`
  contract, and the audit only reads.
- **The live observer sees `Session.append` writes only.** An event written through the handle seam is
  omittable by construction and never re-emits as `session/event`, so it is invisible here. That is the
  safe path, not a blind spot — but it does mean a clean ledger is not proof that a session is clean.
- **A refused log is enumerated only up to its first offender.** The reader stops there, so the audit
  reports one located refusal and says the count is a lower bound instead of presenting what it can see
  as what exists.
- **The vocabulary is the one this process resolved.** `KNOWN_SESSION_EVENT_TYPES` is read through the
  `@deepseek-ai/dsh-session` peer, so inside one process it is the host's copy; every report names the
  version that answered. A plugin carrying its own nested copy would classify against a different set,
  which is why the version is disclosed rather than assumed.
- **A store sweep opens the newest `limit` sessions** (default 20) and says how many it skipped; a
  clean result for the sessions it opened is not a clean store.

## Compatibility

Compiled and tested against the harness `0.1.7` and `0.2.0` prerelease lines. Peer ranges, verbatim:

```
@deepseek-ai/dsh-session                        >=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.0
@deepseek-ai/dsh-session-persistence            >=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.0
@deepseek-ai/dsh-tools                          >=0.1.7-alpha.1 <0.2.0 || >=0.2.0-rc.1 <0.2.0
@deepseek-ai/cordis                             ^4.0.2
```

Each line is probed, not asserted: `npm run test:probe-lines` pins every harness package to each
`||` segment's newest published build, installs, builds and runs the suite there. The range is what
that probe **passed**, not what it was hoped to reach. An earlier draft also named the `0.1.2`,
`0.1.3`, `0.1.5` and `0.1.6` prerelease lines; all four were removed after the probe failed there,
and the reason is worth stating because it is a fact about this suite rather than about those lines:
the suite is v4-shaped. It imports `RELEASED_V3_EVENT_TYPES` from
`@deepseek-ai/dsh-session-format-v3-to-v4` and asserts the v4 refusal, and that package has no build
before `0.1.7`. A line the tests cannot run on is a line nobody ran, so it is not claimed.

`@deepseek-ai/cordis` sits at `^4.0.2` deliberately: its versions do not follow the harness's line
numbering. Note that the 0.1.7 line's own packages peer-depend on `~4.0.4`, so an install that pins
cordis lower than the line needs will fail to resolve — that is the harness's metadata, not this
package's.

### A note on the test tree

The suite runs against the **real** JSONL backend, the real session store and the real
`dsh-session`, and one arm executes a reader **in a separate process that does not import this
plugin** (`test/reader.mjs`) — the scenario the package is about, run rather than described.
`@deepseek-ai/dsh-scope` appears in `devDependencies` only because `dsh-session`'s published metadata
does not declare it while its build imports it; nothing here imports it.

### What the suite is worth

`scripts/inject-defects.mjs` removes one distinction at a time — 42 arms, each a defect this package
could plausibly have shipped — rebuilds, and requires the suite to notice. **41 are caught and one is
a declared equivalent**: copying the payload through a JSON round trip is provably the identity on
the domain `buildExternalEvent` accepts, because the payload validator has already refused every
value a round trip would change. An arm whose mutation leaves the suite green is reported as SILENT
and fails the harness rather than being dropped, so the number is a measurement of the suite and not
a claim about it. The arms found four real gaps while this was being written, and each is now an
assertion (the report's two write-path rows, the sequence the live ledger reports, both ledger bounds
and the mid-enumeration failure path).

## Development

```sh
npm test                  # tsc, then node --test test/*.spec.mjs
npm run test:probe-lines  # every peer line, in a scratch tree each
npm run test:inject       # mutation harness: does the suite notice if the guard breaks?
```

## License

MIT
