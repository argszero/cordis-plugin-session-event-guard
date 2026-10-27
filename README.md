# @argszero/cordis-plugin-session-event-guard

A session log has to stay readable by builds that do not load the plugin that wrote it. One write
path silently breaks that, and the break is deferred to a later process:

```
session "<id>" contains event type "filesnap/point" (seq 0) unknown to this harness and not marked
ignorable; refusing to interpret the log — it was likely written by a newer harness
```

This plugin diagnoses that mistake at the write boundary, audits stored sessions for it through the
same read seam a restart uses, and builds the envelope the public handle seam accepts.

It answers a second mistake of the same shape with the opposite failure distance — a message whose
`source` still uses the anonymous `kind: 'plugin'` wrapper that session format V4 retired. That one
does not wait for a cold load; it stops the durable write that carries it, and the sentence it throws
names neither the event nor the plugin. The plugin locates it: event type, sequence, payload slot,
producer, and the exact replacement.

Origin: [deepseek-ai/deepseek-harness discussion #8233](https://github.com/deepseek-ai/deepseek-harness/discussions/8233),
from the author of `dsh-filesnap`, which reported it after hitting it in practice; and
[discussion #8432](https://github.com/deepseek-ai/deepseek-harness/discussions/8432), which reported
the retired source kind from `dsh-hindsight-memory`.

Mount it:

```yaml
- id: session-event-guard
  name: '@argszero/cordis-plugin-session-event-guard'
```

Published as `@argszero/cordis-plugin-session-event-guard@0.3.0`.

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

- **`session_event_guard` tool** — a write-boundary verdict for a type name (`type`), a verdict on a
  `source` object (`source`, as JSON), an audit of one stored session (`session`), or a sweep of the
  store (neither).
- **A live observer** on `session/event`, so a session that appends an undeclared type — or commits a
  message whose `source` the V4 row admission will refuse — is reported in the process that did it,
  with the type, the sequence and the payload slot.
- **A write-side veto** on `Session.append`, so a payload no reader would accept — a message whose
  `content` is not a parts array, say — is refused at the append site instead of poisoning the log for
  the next reader. See [the third mistake](#the-third-mistake-a-payload-the-reader-refuses-written-through-sessionappend).
- **`buildExternalEvent({ type, data, seq, at? })`** — the envelope the handle seam accepts, with the
  four refusals a hand-rolled one gets wrong.
- **Source judgements** — `inspectSource`, `replacementFor`, `scanEventSources` and `sourceVerdict`,
  plus the `MESSAGE_SLOTS` table and `walkMessageSlots` they are built on, for callers that want the
  answer without the tool.

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

## The second mistake: a message source V4 will not admit

Session format V4 replaced the anonymous `kind: 'plugin'` wrapper with producer-owned attribution.
The literal `'plugin'` is **retired syntax**, and the admission that refuses it sits at the physical
row boundary, so it lands synchronously on the append that carries the message
(`packages/session/session-format-v3-to-v4/src/codec.ts` → `assertV4RowAdmission` →
`assertV4SourceRowAdmission`). What it throws is one fixed sentence:

```
format v4 message requires a producer-owned source kind
```

That sentence names no event, no sequence, no payload slot and no plugin. A plugin author whose turn
dies on it has to bisect their own plugin set to find out which message the harness meant.

**The rule is not a whitelist.** `source()` in
`packages/session/session-format-v3-to-v4/src/message-sources.ts` refuses exactly four things: a
`source` that is not an object, a `kind` that is not a string, a `kind` that is empty, and a `kind`
that is the literal `'plugin'`. Any other non-empty string is admitted, which is why a first-party
plugin never has to register its name anywhere. `plugin:<name>` is not the rule either — it is the
value the harness's own V3→V4 rewrite derives for a name it did not release
(`producerKind` in `sources.ts` falls back to `` `plugin:${plugin}` ``), so it is the *replacement
this plugin suggests*, not a format requirement.

`{"kind":"plugin","plugin":"my-plugin"}` is the shape that breaks. The replacement is
`{"kind":"plugin:my-plugin"}` — the same source with `kind` set and `plugin` dropped, exactly as
`rewritePluginSource` builds it.

### What the plugin says, and where

The live observer runs on the committed event — before the durable write reaches the admission — so it
is the only vantage point that can attribute the refusal. Given a session that commits

```js
session.append('user/message', {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'plugin', plugin: 'hindsight-memory', form: 'snapshot' },
})
```

the append itself **succeeds** (the event is in the live log, seq 0), and the plugin logs:

```
session-event-guard: session "live-source" committed user/message at seq 0 slot data written by plugin
"hindsight-memory" whose `source.kind` is "plugin" (kind-retired). Session format V4 retired the
anonymous `kind: 'plugin'` wrapper, and the row admission refuses this message when the append reaches
storage — with one sentence that names neither the event nor the plugin.
Write {"kind":"plugin:hindsight-memory","form":"snapshot"} instead.
```

The same ledger is in the tool's report, with the sequence and the slot:

```
Live source admission — messages the V4 write path will refuse, located:

  session live-source
    seq 0  user/message  data  kind-retired  plugin="hindsight-memory"
      write instead: {"kind":"plugin:hindsight-memory","form":"snapshot"}
```

And the pre-attach arm judges a `source` before anything carries it —
`session_event_guard({ source: '{"kind":"plugin","plugin":"x"}' })` — which is the cheapest place to
ask, because it needs no session and no write.

### Which slots are walked, and one asymmetry

A message lives in a declared slot of a durable event, and the walk mirrors the harness's own
(`mapEventMessages`): `user/message`'s payload *is* the message; `developer/message`,
`system/message`, `assistant/message` and `tool/result` carry it at `data.message`;
`agent/inbox/spliced` at `data.inserted[]`; `session/title-llm-request` at `data.messages[]`.

The two admission paths are not identical, and flattening the difference would misreport where a
refusal comes from. The **adoption** walk (`assertV4MessageSources`) requires a producer-owned kind on
every one of those slots, `developer/message` included. The **row** walk
(`assertV4SourceRowAdmission`) re-checks only `user/message`, `system/message`, `assistant/message`,
`tool/result`, `agent/inbox/spliced` and `session/title-llm-request`; a retired `developer/message`
source is refused by that event's own row validator instead, with a sentence of its own that also
names `id`, `role` and `content`. Both refuse it. The suite pins both sentences so a future build
cannot move one without the claim failing here.

`MESSAGE_SLOTS` is a mirror of a walk that is not exported, so it is measured rather than trusted:
every entry has a fixture in `test/source-kind.spec.mjs`, and each fixture asserts that a payload with
a producer-owned kind is **admitted** by the real `assertV4RowAdmission` before asserting that the
same payload with the retired wrapper is refused. The control is what makes the arm mean something —
several of these events carry their own row checks (a positive `turn`, a `step`, a first-class tool
message), and a fixture that got one of those wrong would throw for the wrong reason.

### Repair is a value, not a rewrite

`replacementFor` and `sourceVerdict` **compute** the admitted source; they do not apply it. That is
deliberate. The event in the live log is `deepFreeze`d and is the same object every in-memory reader
sees, so a plugin that rewrote a retired `kind` on the way to storage would leave the process holding
`plugin` while the file holds `plugin:<name>` — a representation split that is worse than the mistake
it hides, because it is invisible from both sides. The plugin therefore never writes to a session log
and never edits an event; it hands the caller the exact object to write instead.



- **It does not write to any session log.** Not its own events, not yours. The helper builds an object;
  the caller appends it.
- **It does not change core.** No event type is registered, no vocabulary is extended, and no
  validation is relaxed. The verdict is computed from the vocabulary plus the `session.append`
  contract, and the audit only reads.
- **The live observer sees `Session.append` writes only.** An event written through the handle seam is
  omittable by construction and never re-emits as `session/event`, so it is invisible here. That is the
  safe path, not a blind spot — but it does mean a clean ledger is not proof that a session is clean.
  A retired `source.kind` written through the handle seam throws synchronously at `handle.append`, so
  it is loud without this plugin; the same mistake through `Session.append` is the one only this
  plugin can name, and it is the one the ledger covers.
- **The source arm judges, it does not repair.** See above: it computes the admitted object and states
  it. Nothing here mutates a frozen event, and nothing here writes to a log.
- **A refused log is enumerated only up to its first offender.** The reader stops there, so the audit
  reports one located refusal and says the count is a lower bound instead of presenting what it can see
  as what exists.
- **The vocabulary is the one this process resolved.** `KNOWN_SESSION_EVENT_TYPES` is read through the
  `@deepseek-ai/dsh-session` peer, so inside one process it is the host's copy; every report names the
  version that answered. A plugin carrying its own nested copy would classify against a different set,
  which is why the version is disclosed rather than assumed.
- **A store sweep opens the newest `limit` sessions** (default 20) and says how many it skipped; a
  clean result for the sessions it opened is not a clean store.

## The third mistake: a payload the reader refuses, written through `Session.append`

The first two mistakes are about *which events* a log may hold. This one is about what an event
*contains*, and it is the one the write path does not check at all.

`Session.append` validates the envelope, the surface marker and the request-header rules. It calls
`validateSessionEventData`, whose own doc comment says it "does not validate complete event payloads".
The message-shape invariants — an identified message, a role, a `source`, and `content` as a parts
array — live in `assertMessageEventShape` (`packages/core/session/src/index.ts`), which the append
path never calls. So a message whose `content` is a string appends successfully, and the *reader*
refuses the log later, in whatever process opens it next:

```
session event at seq 0 message has invalid content
```

That is the same failure distance as the vocabulary mistake, with the same consequence: the whole log
is unreadable, not one event dropped, and the process that could have attributed it is long gone. Only
the first mistake has a seam with a marker — this one has none.

### The veto

The reader's validator is module-private, but `adoptSessionEvent` is exported and runs all three
validators. So the veto **asks the package** instead of duplicating its rules: it builds the envelope
`append` is about to build, hands it to `adoptSessionEvent`, and refuses the append when that throws —
quoting the reader's own sentence, not a paraphrase of it.

```yaml
- id: session-event-guard
  name: '@argszero/cordis-plugin-session-event-guard'
```

Mounted, it shadows each session's `append` on the `session/created` hook. Two details make the oracle
exact rather than approximate:

- **The candidate is judged at a sentinel sequence** (`SENTINEL_SEQ`, `Number.MAX_SAFE_INTEGER`). Every
  surface rule that mentions `seq` forbids something being *not earlier* than it, so one value larger
  than any real sequence makes all of them pass for a legitimate event. Guessing the next sequence
  instead would refuse a legitimate `replace` whose `startSeq` is below the guess.
- **The payload is cloned first.** `adoptSessionEvent` deep-freezes what it accepts, and freezing the
  caller's object on the way past would be this plugin mutating a value it was only asked to judge.

A refusal is a throw at the append site:

```
SessionEventGuardError: refusing to append user/message to session "…": session event at seq
9007199254740991 message has invalid content. This event was not committed. A reader that does not
load this plugin would have refused the whole log later, in a process that could not attribute it.
```

Set `VETO_MODE = 'observe'` to report and commit anyway — the shape an operator needs to see the real
failure on a live session rather than to keep it clean.

### What the veto covers, and what it does not

- **It prevents the malformed event from landing; it does not repair a log already poisoned.** Each
  session's `append` is shadowed at `session/created`, so the refused event never reaches the durable
  log and the next reader sees a log with no defect in it. A log poisoned *before* this plugin was
  installed is untouched: for that, `session_event_guard` with `session` reports the reader's refusal,
  and recovering the session is a separate operation this package does not perform.
- **It covers sessions announced through `session/created`.** A session object obtained some other way
  — constructed directly, or created before this plugin applied — is not shadowed. `installWriteVeto`
  is exported for callers that hold such a session and want the same verdict; it reports `no-append`
  or `not-writable` as an outcome rather than throwing into the lifecycle edge that delivered it.
- **A payload `append` would itself refuse is left to `append`.** `BigInt`, a function, a cycle: those
  are refused by the write path in every process with or without this plugin, and with a sentence that
  names the real problem. Refusing them here first would pre-empt that sentence and claim a durability
  hazard that does not exist, so the veto stands back whenever its shape verdict would be the wrong
  one. That check runs only on the failure path, so it costs nothing on a healthy append.
- **It is a shadow, and shadows are reversible.** `restore()` unwinds it, and unwinds only a shadow
  that is still its own — a later guard's `append` is left alone.


Compiled and tested against the harness `0.2.1-rc.3` line. Peer ranges, verbatim:

```
@deepseek-ai/dsh-session                        >=0.2.1-rc.3 <0.2.1
@deepseek-ai/dsh-session-persistence            >=0.2.1-rc.3 <0.2.1
@deepseek-ai/dsh-tools                          >=0.2.1-rc.3 <0.2.1
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
`@deepseek-ai/dsh-session-format-v3-to-v4` is a `devDependency` and is imported by the suite only:
`test/source-kind.spec.mjs` runs the real `assertV4RowAdmission` against every slot `MESSAGE_SLOTS`
claims, so the mirror this package walks is checked by the harness's own walk instead of by a second
hand-written copy of it. Nothing in `src/` imports it.
`@deepseek-ai/dsh-scope` appears in `devDependencies` only because `dsh-session`'s published metadata
does not declare it while its build imports it; nothing here imports it.

### What the suite is worth

`scripts/inject-defects.mjs` removes one distinction at a time — 66 arms, each a defect this package
could plausibly have shipped — rebuilds, and requires the suite to notice. **65 are caught and one is
a declared equivalent**: copying the payload through a JSON round trip is provably the identity on
the domain `buildExternalEvent` accepts, because the payload validator has already refused every
value a round trip would change. Six of the arms cover the write-side veto, one per distinction it
could get wrong: asking the reader and discarding the answer, judging at sequence zero instead of the
sentinel, judging (and so freezing) the caller's own object, refusing in `observe` mode, unwinding
over a later guard's shadow, and surviving the disposal of the plugin that installed it. An arm whose mutation leaves the suite green is reported as SILENT
and fails the harness rather than being dropped, so the number is a measurement of the suite and not
a claim about it. The arms found four real gaps while this was being written, and each is now an
assertion (the report's two write-path rows, the sequence the live ledger reports, both ledger bounds
and the mid-enumeration failure path).

An arm whose mutation no longer applies is reported as **NO-OP**, and that is not a formality either:
adding this release's surface moved the ledger into a shared helper, and five arms silently stopped
matching the code they were supposed to mutate. The harness said so — `NO-OP`, five times — where a
`green` suite would not have. Their `edits` were repointed at the new source and all five are caught
again. A mutation harness that only reports SILENT is half a harness; the other half is noticing that
it stopped mutating anything.

## Development

```sh
npm test                  # tsc, then node --test test/*.spec.mjs
npm run test:probe-lines  # every peer line, in a scratch tree each
npm run test:inject       # mutation harness: does the suite notice if the guard breaks?
```

## License

MIT
