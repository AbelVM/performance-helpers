# 0006. A resume sequence rides in the envelope, not the frame header

**Status:** Proposed
**Affects:** `PowerRealtimeHub`, `PowerMessageCodec`, GAP-009

## Context

GAP-009 asks for resumable sessions: a sequence number in the frame, a
`resume(sessionId, lastSeq)` entry point, and hub-side replay. Its note calls it
"the highest-value gap in the library, and not a transport", on the strength of
production guidance that exponential backoff solves the transport problem while
the hard problem is what happens _after_ a reconnect, when state on both sides has
diverged. The three named approaches are sequence-and-replay, event sourcing, and
last-known-state sync.

The row asserts that "the pieces exist" and that the hub "is just missing the
question _what did I miss?_". Two of those premises were checked before designing
anything, and **one holds in a much weaker form than the row implies while the
other hides a library-wide blast radius.**

**1. The frame header exists, but it is not the hub's.** `powerMessageCodec.js`
frames as `[version][0][u32 length]` with `MESSAGE_PROTOCOL_VERSION = 1`
(`powerMessageCodec.js:13-15`, `:59-60`), and strict decoding rejects any other
version outright (`:282`). The important part is who else uses it: the hub frames
its own deliveries through the same codec (`powerRealtimeHub.js:830`, `:853`, via
`encodeMessage` and `frameEncodedJson`). So a header change is **not** a hub-local
edit. It reaches `PowerPool`'s negotiated protocol, `PowerWebSocketClient`, every
pool worker, and `bench/claims.js carrier`, which measures message-carrier
fidelity and encode cost — a header change makes that measurement a different
measurement. A `protocol v2` here is a breaking wire change for the whole library,
and the row's size estimate does not say so.

**2. The retained log is not a session log.** The hub has a bounded retained log,
`RETAIN_LIMIT = 32` messages per topic (`powerRealtimeHub.js:164-166`), and an
earlier row made it load-bearing by replaying it to new subscribers
(`:354-372`). But it is **retained state, scoped per topic, with no ordering
metadata across topics and no way to express a range**. "What did I miss between
seq N and now" is not a question a `Map<string, any[]>` can answer, and 32
messages is a snapshot window rather than a replay buffer. Meanwhile the hub has
**no session concept at all** — zero occurrences of `session` in
`powerRealtimeHub.js`. The `resume()` methods elsewhere are a stream-pause
(`powerWebSocketClient.js`) and a pool scheduler (`powerPool.js:4549`), neither
related.

So the framing of the gap is right and the inventory is wrong: the missing piece
is larger than a session id, and the piece that exists cannot be reused as-is.

## Decision

**Carry the sequence number in the envelope payload, not in the frame header.**
`MESSAGE_PROTOCOL_VERSION` stays at 1 and no wire-format break ships with this
feature.

The header is the wrong home for it for three reasons that are specific to this
library rather than general:

- A v1 receiver rejects a v2 frame and a v2 receiver rejects a v1 frame _loudly_
  (`powerMessageCodec.js:282`), which is the correct behaviour for a protocol
  change and exactly the wrong behaviour for adding a field. Every mixed-fleet
  deploy would break on a feature whose only purpose is surviving reconnects.
- The sequence is only meaningful to a hub that has a session, and the hub is the
  only component that will read it. Putting it in the header makes the pool and
  every worker carry a field they must encode, frame, and preserve for a consumer
  they have no concept of.
- The hub already pays a `JSON.stringify` per batch (`powerRealtimeHub.js:853`).
  A sequence field inside the batched JSON is close to free there, where a header
  change is a `tsc`-visible change to a shared constant plus its migration guide.

The cost is stated rather than discovered later: **a broker cannot read the
sequence without decoding the payload.** That is acceptable here because the hub
both produces and consumes these frames, so there is no intermediary that needs
the field without the payload. It would _not_ be acceptable if a frame-passing
proxy were added, and that is the condition to revisit this decision under.

## Consequences

- `bench/claims.js carrier` keeps measuring the framing it was written against. If
  the header ever does change, that mode must be re-run before its numbers are
  quoted, which is the same obligation the version byte already carries.
- A session needs its own bounded, ordered log. Reusing `_retained` would mean
  changing its semantics from retained-state to ordered-history for every existing
  `retain: true` caller, which is a breaking change to a different feature. The
  session log is therefore a separate structure with its own bound.
- Sequence numbering is per session and therefore per hub process. It says
  nothing about ordering _across_ hubs, which is the same boundary ADR 0001 drew
  when it made the envelope versioned rather than the payload self-describing.
- **GAP-009's row needs re-scoping before it is worked.** "L" understated it: the
  feature spans a new per-session log, a session registry, an API on the hub, and
  a client-visible sequence contract. The honest size is larger, and it wants the
  ADR accepted first.

## What would change this decision

- A frame-passing intermediary appears between hub and client, and it needs the
  sequence to route, deduplicate, or shed load without decoding payloads. Then the
  field belongs in the header and `protocol v2` is the honest cost.
- The hub's throughput measurement shows the extra payload bytes mattering against
  a codec cost the `carrier` mode already reports. That is a measurement to run,
  not a reason to assume.
