# 0011. An acknowledging BroadcastChannel protocol is required before the hub can use it

**Status:** Proposed
**Affects:** `PowerRealtimeHub`, BC-003, future `createBroadcastBus` helper

## Context

BC-003 asks for `createBroadcastBus({ channel, ackTimeoutMs })` — an
_acknowledging_ channel so a `BroadcastChannel` can carry the hub's slow-consumer
contract honestly. The row's premise was checked against the platform before any
design was drafted, and **the platform gives nothing to build on**:

- no `bufferedAmount`
- no `readyState`
- no `desiredSize`
- `postMessage` returns `undefined`
- 400 000 × 1 kB against a 1 ms-per-message consumer drove RSS to **203 MB**
  with no signal

The hub's slow-consumer contract is: _if a subscriber falls behind, the hub
observes it and acts on it_. A `BroadcastChannel` cannot observe that, because
the platform does not expose the receiver's queue depth, the number of messages
waiting to be delivered, or any backpressure signal at all. The only thing the
sender can see is whether `postMessage` throws — and it throws only when the
_current_ message cannot be cloned, not when the receiver is behind.

So the row's framing is right and the naive implementation is wrong: wrapping a
`BroadcastChannel` in a `send(sub, frame)` adapter and hoping the hub's queue
limits protect the process would give the hub a queue it cannot see, and a
slow-consumer policy driven by a counter the transport does not report.

## The problem

`PowerRealtimeHub`'s `send(sub, frame)` adapter contract is:

1. Return `true` when the transport accepted the frame.
2. Return `false` when the transport refused it transiently.
3. Throw when the transport refused it permanently.

The hub uses the return value to update `sub.inFlight` and to decide whether a
batch is still in flight. A `BroadcastChannel` adapter that always returned
`true` would lie about the receiver's state; one that always returned `false`
would lie about the sender's; and one that threw would kill the hub on every
message, because `postMessage` does not throw for a slow receiver — it throws
for a transfer-list error or a closed channel.

The 203 MB measurement is the concrete cost of that mismatch: with no
backpressure and no ack, the sender queues frames in the hub's per-subscriber
buffer while the receiver's `onmessage` handler runs at 1 ms per message. The
hub's `maxQueue` limit eventually fires, but by then the process has already
allocated the memory for the backlog — and `drop-oldest` discards frames the
receiver never saw, which is the exact failure the hub exists to prevent.

## Decision

**A `BroadcastChannel` bus must implement an application-level acknowledge
protocol before the hub can use it.** The protocol has three parts:

1. **Ack per frame.** Every outbound frame carries a sequence number. The
   receiver posts an `ack` message back to the sender for each frame it has
   processed. The ack is a separate `postMessage` call, not a reply on the same
   channel — the hub's own `PowerMessageCodec` already distinguishes envelope
   types, so the bus can reuse that shape without inventing a new wire format.

2. **Pending counter with a timeout.** The sender tracks how many frames are
   outstanding for each receiver. A frame is considered delivered when its ack
   arrives, or when `ackTimeoutMs` elapses — whichever comes first. The timeout
   is the slow-consumer signal: a receiver that does not ack within the window
   is behind, and the hub's policy (`drop-oldest`, `drop-newest`, `disconnect`)
   is applied to _that receiver_ rather than to a queue the hub cannot see.

3. **Slow-consumer policy driven by the pending counter.** The hub's existing
   `SlowConsumerPolicy` enum is reused unchanged. The difference is _what_
   triggers it: instead of `sub.queue.length >= sub.maxQueue`, the bus reports
   `sub.pending >= sub.maxPending`, where `maxPending` is derived from
   `ackTimeoutMs` and the measured ack rate. A receiver that acks at 1 ms per
   message can have `maxPending = 1`; one that acks at 100 µs can have
   `maxPending = 10`. The hub does not need to know the transport's queue depth;
   it only needs to know when the receiver is not keeping up.

## Why this is a protocol, not an adapter

The hub's `send(sub, frame)` adapter is called with a single frame and a single
subscriber. A `BroadcastChannel` is one-to-many: one `postMessage` reaches every
context listening on that channel. So the adapter shape does not fit — the hub
would have to call `postMessage` once per subscriber, which is exactly the
explicit `MessagePort` loop `bench/claims.js bcfanout` measured and found
slower than a single channel post at K ≥ 4.

The right shape is therefore a _bus_: one channel, one `postMessage` per frame,
and a per-receiver ack stream that the bus demultiplexes. The hub subscribes to
the bus, not to the channel; the bus owns the ack protocol and reports per-
subscriber delivery state back to the hub through the existing `send`/`close`
adapter contract.

## Consequences

- **`createBroadcastBus` is a new helper, not a change to `PowerMessagePort` or
  `PowerRealtimeHub`.** The hub's adapter contract stays unchanged. The bus
  implements `send(sub, frame)` and `close(sub)` and is wired into the hub the
  same way any adapter is.
- **The ack stream is a second `BroadcastChannel` or a `MessagePort` per
  receiver.** A single shared ack channel is simpler but requires the bus to
  demultiplex by receiver id; a per-receiver `MessagePort` is cleaner but
  requires the receiver to expose a port. The ADR does not pick one — that is
  the implementation detail the row's note leaves open.
- **`ackTimeoutMs` is the slow-consumer ceiling, not a retry timer.** A timed-out
  frame is not retransmitted; it is counted as a delivery failure and the
  receiver's pending counter is decremented. Retrying would hide the slow-
  consumer signal, which is the one thing the bus exists to surface.
- **The 203 MB measurement is the baseline.** Any implementation of this row must
  reproduce that measurement before claiming the protocol works: 400 000 × 1 kB
  against a 1 ms-per-message consumer, and the RSS must stay bounded. If it does
  not, the ack protocol is not the problem — the platform is, and the row's
  conclusion is that `BroadcastChannel` cannot be made to carry this contract
  honestly.
- **BC-001's measurement is the prerequisite.** The row already exists and is
  done: `bench/claims.js bcfanout` measures sender-side cost of one channel post
  against K explicit `MessagePort` posts. BC-003's protocol adds one ack post
  per frame per receiver, so the sender-side cost doubles — the bus must stay
  inside the band BC-001 measured for the channel to be the right choice.

## What would change this decision

- A future version of the platform exposes `bufferedAmount` or an equivalent
  backpressure signal on `BroadcastChannel`. Then the ack protocol is unnecessary
  and the row collapses to a one-line adapter.
- The 203 MB measurement is reproduced on a different engine or Node version and
  the RSS is bounded without an ack protocol. Then the row's premise is wrong
  and the adapter shape is sufficient.
- The hub's slow-consumer contract is relaxed to allow best-effort delivery.
  Then the bus can drop the ack stream and become a fire-and-forget broadcast,
  which is a different helper with a different name.
