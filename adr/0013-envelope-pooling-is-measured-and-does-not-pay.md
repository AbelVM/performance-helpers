# 0013. Envelope pooling is measured and does not pay

**Status:** Rejected
**Affects:** `PowerMessageCodec` (`src/helpers/powerMessageCodec.js`) — no pooling option is added
**Evidence:** `node bench/claims.js envelopepool`, a new mode added for this row, run 2026-10-09. Four runs.

## Context

P1 asked whether object pooling for hot realtime paths — specifically the
`MessageCodec` decode envelope — pays for itself, behind an opt-in flag. The
row's own framing is the right one: "Trade memory vs allocs; measure with bench
before committing. Avoid global pools that leak across realms."

The premise is that allocation is the cost. `decodeMessage` returns a fresh
`{ version, codec, value, byteLength }` per call, and on a path that decodes
thousands of messages a second that is a lot of short-lived objects.

## Measurement

A new `envelopepool` mode in `bench/claims.js`. Both arms run the **real**
`decodeMessage` — a synthetic object literal would have measured the wrong
thing, because the envelope is one of several allocations per message and the
ratio is what decides the row. The pooled arm reuses one envelope and
overwrites its four fields. A third arm reads one field and allocates nothing
extra, to show the envelope's own share of the total.

Four runs, 200k ops each:

| run | fresh envelope | pooled, fields overwritten | ratio |
| --: | -------------: | -------------------------: | ----: |
|   1 |       766.1 ns |                   818.6 ns | 1.07x |
|   2 |       818.0 ns |                   852.8 ns | 1.04x |
|   3 |       602.1 ns |                   621.9 ns | 1.03x |
|   4 |       604.8 ns |                   618.3 ns | 1.02x |

**Pooling is never faster.** It is equal-or-slightly-worse in four runs out of
four, and the direction is consistent even though the magnitude sits inside the
harness's noise band.

## Decision

**Do not build envelope pooling.** The premise — that allocation is a
significant cost on this path — is not supported. The envelope's allocation is
lost inside the decode's own cost, and overwriting four fields on a warm object
costs at least as much as letting the young generation reclaim a fresh one.

The reason to reject it is stronger than "no measurable win", though. A pool
hands the caller an object that the next decode **overwrites**. A caller who
keeps a reference — a queue, a retry, a log line, an `await` boundary — sees
silent corruption. That is a far worse failure than the allocation it was meant
to save, and it is why the row specified an opt-in flag rather than a default.
A footgun that buys nothing is not a trade.

## What survives

The measurement itself, and the shape of the question. The row was right to ask
for a benchmark first: the intuitive answer — "allocating an object per message
must cost something" — is wrong here, and the only way to know is to run it.

This is the sixth item in this project's history to be scoped to a number nobody
had produced, and the sixth to be wrong. The pattern is worth naming because it
keeps recurring: a structurally appealing change, a plausible mechanism, and no
measurement until after the design is settled.

## Not measured

- **A pooled envelope on the encode path.** `encodeMessage` allocates a frame
  buffer as well as an envelope, and the buffer is the larger allocation. If a
  future row revisits pooling, the frame buffer is the thing to measure first —
  and it is a harder problem, because a pooled buffer handed to `postMessage`
  is transferred and cannot be reused.
- **Pooling under a real transport.** The mode measures `decodeMessage` in a
  loop. A caller decoding inside a `message` event handler pays the same decode
  cost plus the handler's, and the envelope's share would be smaller still, not
  larger.
