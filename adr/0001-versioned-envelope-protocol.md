# 0001. The pool frames every message in a versioned binary envelope

**Status:** Accepted
**Affects:** `PowerMessageCodec`, `PowerPool`, `PowerRealtimeHub`, every pool worker

## Context

`PowerPool` moves messages between worker threads. The runtime gives you
`postMessage`, which does structured clone — and structured clone alone is not a
wire protocol, for three separate reasons.

**1. The obvious text framing is broken by ordinary data.** Newline-delimited
JSON is the cheapest protocol to write and the one everyone reaches for. It
fails on any value containing a newline inside a string, which is every value
containing user text. The bug is in NDJSON's own specification, not in an
implementation of it. See `examples/codec.mjs`, which demonstrates the split
producing three "records" from one object.

**2. A decoder must be able to tell what it is looking at.** The 1.x pool
sniffed the payload to decide whether it was JSON or a structured-clone
object. That worked until it met a payload that was valid as both, at which
point the decoder guessed, and a guess is a corruption bug that surfaces as
garbage data in someone else's process.

**3. A rolling deploy has two fleet versions in flight.** If the protocol can
change, a worker and a pool must be able to disagree loudly. A sniffing
decoder cannot; a versioned one can.

## Decision

Every message crosses the wire as an explicit binary envelope:

```
[u8 version][u8 codec][u32 length][payload]
  6-byte header, little-endian length
```

- `version` is `MESSAGE_PROTOCOL_VERSION`, currently `1`. A decoder in `strict`
  mode (the default) **rejects** any other value rather than attempting to read
  it.
- `codec` selects the payload encoding from a fixed table — `json`, `v8`, or
  `raw` — so the payload is never sniffed.
- `length` is the payload byte count, so a stream reader knows how much to
  consume without parsing, and a truncated frame is detectable rather than
  silently short.

Binary payloads are _not_ an exception to the framing. They get the `raw` codec
and a real header, so "is this a bare typed array or an encoded object" is not
a question a receiver has to answer.

## Consequences

- A worker author must call `decodeMessage` on the way in and `encodeMessage` on
  the way out. This is a real cost, and it is the single most common way a
  first pool worker fails: the message arrives as a `Uint8Array`, so
  `data.someField` is `undefined` and the body silently does nothing.
- Six bytes per message. Irrelevant next to the encode, and the header is
  written by hand rather than through a `DataView` specifically to avoid
  allocating one on a hot path.
- `PowerPool` caches encoded forms and transfers the buffer rather than
  re-serialising, so the framing is what makes `zeroCopy` possible at all.
- The version byte buys the thing it is for: during a rolling deploy, an old
  worker receiving a new envelope gets a `RangeError` naming both versions,
  rather than a misparse.

## Alternatives considered

**Structured clone only, no framing.** Cheapest, and it is what the pool would
use if all it did were pass objects. Rejected: it cannot represent a binary
payload without an out-of-band convention, and it cannot be versioned.

**NDJSON.** Rejected: breaks on newlines in strings, and carries no length, so a
stream reader cannot frame.

**Length-prefixed JSON without a version or codec byte.** Better than NDJSON and
was a genuine contender. Rejected because it does not solve (2) or (3): a
decoder still cannot tell JSON from something else, and a protocol change is
still silent.

**Protocol negotiation at worker start-up.** More capable, considerably more
code, and it requires the very thing that is unavailable in a failing first run
— a working message channel.

### Amendment (FEAT-012): negotiation, with the direction reversed

The rejection above was correct **as written** and the reasoning still stands: a
pool-asks handshake has to put a control message on a worker's port, and in the
failing first run there is no worker to answer it — or, worse, a worker that
does not implement it and runs the handshake as a task.

Negotiation shipped anyway, with the exchange reversed: **the worker advertises,
the pool only listens.** A worker that understands the protocol posts its
capabilities once at start-up; a worker that does not stays silent, and silence
is the only thing negotiation asks of it. The objection is answered by removing
the requirement, not by arguing that the requirement is smaller than it looked.

What made it worth revisiting is the fidelity table. The frame is not merely a
slower carrier, it is a _lossy_ one: a `Map` arrives as `{}`, a `Date` as an ISO
string, `BigInt` throws. The decision to frame was a decision to describe every
message as JSON, and that description is wrong for values a worker will
reasonably be handed. Negotiation is how the pool stops assuming.

Two constraints from this ADR held throughout, and are why the feature is
opt-in at both ends:

- **Framing stays the default.** An existing pool sending to an existing worker
  must not change behaviour because a new option exists.
- **The carrier is explicit on both sides.** A native envelope is a marked
  object, read by shape — not sniffed. Sniffing was context (2) above, and this
  feature is not a route back to it.

The speed claim that originally motivated the row was measured and is false; see
`node bench/claims.js carrier` and `guides/powerMessageCodec.md`. Fidelity is
the justification, which is why the decision is per worker rather than per pool.

## Where this is visible

`guides/powerMessageCodec.md` is the reference. The framing is a _published_
contract: a hand-written worker depends on it, and `examples/lib/worker.mjs`
shows the decode/encode pair a real pool worker needs. `guides/troubleshooting.md`
covers the symptom when a worker forgets the decode step.
