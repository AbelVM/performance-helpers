# createBroadcastBus

A `BroadcastChannel` bus with **per-frame acknowledgement**, a **pending counter
with timeout**, and **slow-consumer detection**.

`BroadcastChannel` gives you no backpressure signal: no `bufferedAmount`, no
`readyState`, no `desiredSize`, and `postMessage` returns `undefined`. A slow
receiver is invisible to the sender until the process runs out of memory. This
bus adds an application-level ack protocol so the sender can observe and react
to a slow consumer honestly.

## Why a bus, not an adapter

`PowerRealtimeHub`'s `send(sub, frame)` adapter is one frame to one subscriber.
`BroadcastChannel` is one-to-many: one `postMessage` reaches every context on
the channel. The adapter shape does not fit — the hub would have to call
`postMessage` once per subscriber, which `bench/claims.js bcfanout` measured and
found slower than a single channel post at K ≥ 4.

The right shape is a **bus**: one channel, one `postMessage` per frame, and a
per-receiver ack stream the bus demultiplexes. The hub subscribes to the bus,
not to the channel; the bus owns the ack protocol and reports per-receiver
delivery state back through the existing `send` / `close` adapter contract.

## Constructor

```javascript
import { createBroadcastBus } from 'performance-helpers';

const bus = createBroadcastBus({
  channel,
  ackTimeoutMs: 5000,
  onSlowConsumer: (receiverId) => {
    console.warn('slow consumer', receiverId);
  },
});
```

| Option           | Type                           | Default | What it means                                                                                                                                               |
| ---------------- | ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channel`        | `BroadcastChannel`             | —       | **Required.** The channel to post frames on.                                                                                                                |
| `ackTimeoutMs`   | `number`                       | `5000`  | Milliseconds before an unacknowledged frame marks the receiver slow.                                                                                        |
| `onSlowConsumer` | `(receiverId: string) => void` |         | Called once when a receiver is first marked slow. The bus never touches subscriber records — the hub passes a callback that sets `sub.slowConsumer = true`. |

An unrecognised option throws — every helper in this library validates its
options against this list.

## API

- `send(sub, frame)` → `boolean`. Posts `frame` to the channel with a sequence
  number and the receiver's id. Returns `true` while the bus is open, `false`
  after `dispose()`. Throws if `sub.id` is not a string.
- `close(sub)` → `void`. Clears all pending timers and resets the pending
  counter for `sub.id`. A no-op if `sub.id` is missing.
- `getSlowConsumerIds()` → `Set<string>`. A snapshot of receivers currently
  marked slow.
- `dispose()` → `void`. Removes the message listener, clears all timers and
  state. Idempotent.

## The ack protocol

Every outbound frame is wrapped with a sequence number and the receiver's id:

```javascript
{
  _bc: true,
  seq: 1,
  receiverId: 'client-42',
  frame: Uint8Array,
}
```

The receiver posts an ack back as a **native envelope**:

```javascript
import { encodeNativeEnvelope } from 'performance-helpers';

channel.postMessage(
  encodeNativeEnvelope({
    type: 'ack',
    payload: new TextEncoder().encode(JSON.stringify({ seq: 1, receiverId: 'client-42' })),
  })
);
```

The bus listens for native envelopes, decodes the ack payload, matches it
against the pending map by `seq` and `receiverId`, clears the timeout, and
decrements the receiver's pending counter. A receiver that acks before
`ackTimeoutMs` elapses is never marked slow.

## Slow-consumer detection

A receiver is marked slow when its pending counter exceeds the threshold or when
an ack times out. The threshold is internal (`SLOW_THRESHOLD = 2`); the
timeout is the caller's `ackTimeoutMs`.

The bus does **not** touch subscriber records. It reports slow receivers through
`getSlowConsumerIds()` and the optional `onSlowConsumer` callback. The hub
decides what to do — drop frames, disconnect, or warn — using the same
`slowConsumer` policy it uses for every other transport.

## Why the pending counter, not a queue

The hub's existing slow-consumer contract is driven by a queue length:
`sub.queue.length >= sub.maxQueue`. A `BroadcastChannel` has no queue the hub
can see, so the bus substitutes a **pending counter**: the number of frames
sent but not yet acked.

The counter is not a queue. It does not buffer frames, it does not reorder them,
and it does not drop them. It counts outstanding acks, and the timeout is the
signal that a receiver is not keeping up. The hub's policy is applied to that
signal, not to a buffer the transport does not expose.

## Example

```javascript
import { PowerRealtimeHub, createBroadcastBus } from 'performance-helpers';

const channel = new BroadcastChannel('room');
const bus = createBroadcastBus({
  channel,
  ackTimeoutMs: 2000,
  onSlowConsumer: (id) => console.warn('slow', id),
});

const hub = new PowerRealtimeHub({
  send: (sub, frame) => bus.send(sub, frame),
  close: (sub, reason) => bus.close(sub),
  batch: false,
});

hub.subscribe('chat', (msg) => render(msg), { id: 'client-1', maxQueue: 32 });

channel.onmessage = (event) => {
  const data = event.data;
  if (data && data._bc) {
    render(data.frame);
    // Ack back.
    channel.postMessage(
      encodeNativeEnvelope({
        type: 'ack',
        payload: new TextEncoder().encode(
          JSON.stringify({ seq: data.seq, receiverId: data.receiverId })
        ),
      })
    );
  }
};

hub.publish('chat', { text: 'hello' });
await hub.flush();
```

## Notes

- The bus is **one-directional**: it posts frames and listens for acks on the
  same channel. If your topology needs a separate ack channel, create a second
  `BroadcastChannel` and pass it as the bus's `channel` — the ack protocol is
  self-contained.
- `dispose()` is the teardown. It removes the listener and clears all timers,
  so a bus that is no longer needed does not keep the event loop alive.
- A timed-out frame is **not retransmitted**. The timeout is the slow-consumer
  signal, not a retry trigger. Retrying would hide the signal the bus exists to
  surface.
