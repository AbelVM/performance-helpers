# PowerSequencer

Gap detection and in-order reassembly for a datagram-style transport.

## When to use

- Receiving out-of-order datagrams from an `RTCDataChannel` or `WebTransport` datagram stream
- Any transport that gives you messages rather than a stream, where ordered state matters
- Deciding when to NACK: `missing()` is exactly the list a retransmission request would carry

## Installation

```js
import { PowerSequencer } from 'performance-helpers/powerSequencer';
```

## API

### new PowerSequencer(options)

Options: `{ windowSize?, startAt?, onGap?, onMessage?, observability? }` or just `windowSize` (number).

- `windowSize` (number, default 64) — how many sequence numbers ahead of the next expected one may be buffered. A datagram beyond the window is refused and counted in `stats().outOfWindow`.
- `startAt` (number, default 0) — the first sequence number expected. Set it when the peer's numbering does not start at zero.
- `onGap` (function) — called as `(seq, missing)` when a datagram arrives above the next expected sequence, so a gap exists. Fired once per **newly opened** gap, not once per datagram arriving inside an existing one.
- `onMessage` (function) — called as `(seq, payload)` for each message released, in sequence order. A single `push()` can release several.
- `observability` — opt in to metrics, as every other helper here.

### Methods

- `push(seq, payload)` — accept one datagram. Returns `true` if it entered the window. A duplicate or an out-of-window datagram returns `false` and is counted; neither is buffered.
- `missing()` — the sequence numbers being waited on, ascending. Derived from the buffer, so it cannot drift out of step with what is held.
- `reset()` / `clear()` — discard buffered state and resume from `startAt`.
- `dispose()` / `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` — a **state reset**, because this helper owns no timer and no listener registry.

### Properties

- `nextExpected` — the next sequence number that will be released.
- `buffered` — how many datagrams are held ahead of the gap.

### stats()

`nextExpected`, `buffered`, `missing`, `delivered`, `duplicates`, `outOfWindow`, `gapsOpened`, `windowSize`.

`gapsOpened` counts **distinct gaps**, not datagrams that arrived inside one — so it is the number to alert on. `duplicates` climbing is the signal that a NACK path is misbehaving, since a retransmitting peer is normal on a lossy link.

## What it deliberately does not do

It does not retransmit, and it does not time out. Both need a clock and a policy that belongs to the transport, not to a reassembler — a NACK interval is a property of the link, and inventing one here would put a second, contradictory retransmission policy in the library.

What it does is make the gap **visible**. `missing()` answers exactly which sequence numbers are being waited on, and `onGap` fires the moment one appears, so the caller can decide to NACK, to give up, or to keep waiting.

## The window

Bounded by `windowSize`, measured from `nextExpected` — which **advances** as messages are released. So after `push(0)` is released, `next` is 1 and the window is `[1, 1 + windowSize)`.

A datagram beyond the window is refused rather than buffered, so a peer that jumped ahead — or a peer whose numbering restarted — cannot grow this without limit.

## Examples

```js
import { PowerSequencer } from 'performance-helpers/powerSequencer';

const seq = new PowerSequencer({
  windowSize: 128,
  onGap: (s, missing) => channel.send({ type: 'nack', missing }),
  onMessage: (s, payload) => handle(s, payload),
});

channel.addEventListener('message', (e) => seq.push(e.seq, e.payload));
```

```js
// Out-of-order arrival: 1 and 2 are held, 0 releases all three.
const seen = [];
const seq = new PowerSequencer({ onMessage: (s) => seen.push(s) });
seq.push(1, 'b');
seq.push(2, 'c');
seq.missing(); // [0]
seq.push(0, 'a');
// seen is now [0, 1, 2]
```

```js
// Takes part in `using` / `await using` like every other long-lived helper.
{
  using s = new PowerSequencer({ windowSize: 64 });
  s.push(1, 'b');
} // state released here
```
