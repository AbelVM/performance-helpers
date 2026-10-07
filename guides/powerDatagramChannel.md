# PowerDatagramChannel

> **Server-side helper** — wraps an existing datagram-style transport and
> makes oversize refusals and silent discards loud and countable.

A bounded, drop-counting wrapper for a datagram-style transport (`RTCDataChannel`,
`WebTransport` datagram stream, or anything with a `send(data)` method).

Where `PowerRTCChannel` and `PowerSocketAdapter` normalise a transport so the hub
can treat it like a socket, `PowerDatagramChannel` does the opposite: it accepts
that a datagram transport has a **message-size ceiling** and a **silent-discard**
failure mode, and it makes both loud and countable.

## Why this exists

Datagram transports have two failure modes that a framed socket does not:

1. **Oversize datagram → platform throws or silently discards.** A `WebSocket`
   buffers and gets slower; an `RTCDataChannel` throws; a `WebTransport` datagram
   stream silently drops. None of them tell the sender _that_ they dropped.
2. **No back-pressure signal.** Datagrams are not flow-controlled. The receiver
   drops from the head, and the sender has no event to wait on.

The silent-discard case is the dangerous one. A caller that never learns a
datagram was dropped has no way to count the loss, and a hub that cannot count
drops cannot honour its slow-consumer contract. This class exists to make the
refusal **loud and countable**.

## What this is not

This is **not** a `PowerRealtimeHub` `send(sub, frame)` adapter. The hub's
`retain` feature and datagrams contradict each other: a retained message is a
framed JSON payload, while a datagram is an unframed binary blob. Wrapping a
datagram channel in a hub adapter would silently drop the `retain` guarantee
every time the platform discards an oversize datagram.

Use this class directly when you need bounded, counted datagram delivery, or
wrap it in your own adapter that knows how to frame and retain.

## Two refusals, and they are not the same thing

`send()` has two distinct failure paths, and they differ in whether the caller
should retry:

| Condition                               | Outcome                | Caller should                     | Counted in                  |
| --------------------------------------- | ---------------------- | --------------------------------- | --------------------------- |
| Datagram exceeds `maxDatagramSizeBytes` | **`TypeError` thrown** | Never — no retry makes it smaller | `stats().oversizeDatagrams` |
| Transport not open, or queue full       | **`false` returned**   | Yes — transient                   | `stats().droppedCount`      |

The oversize refusal is **permanent and pre-emptive**: the check runs before the
platform sees the datagram, so an oversize frame is never handed to the
transport. This is the opposite of the platform's silent-discard behaviour, and
it is the whole point of the class.

The not-open / queue-full refusal is **transient**: the caller retries. When the
internal queue is full, the oldest queued datagram is dropped first
(`drop-oldest`) and the new one is queued in its place, so the queue stays at
capacity and the loss is observable in `droppedCount`.

## Queue behaviour

`maxQueue` controls how many datagrams are buffered while the transport is not
ready. The default is `64`. Set it to `0` to disable queueing entirely: a
datagram arriving while the transport is closed is refused immediately.

When the queue is full and a new datagram arrives:

1. The oldest queued datagram is removed.
2. `droppedCount` is incremented by `1`.
3. The new datagram is queued in its place.
4. `send()` returns `true` — the datagram was accepted, not refused.

This means a full queue never refuses the incoming datagram; it trades one
queued entry for another and reports the trade. If you need a hard ceiling that
refuses rather than drops, size `maxQueue` for the worst case and monitor
`droppedCount`.

## Usage

```javascript
import { PowerDatagramChannel } from 'performance-helpers/powerDatagramChannel';

// A transport with a `send(data)` method and an optional `readyState` or
// `isOpen` property. The transport is used as-is; this class does not
// normalise its state machine.
const channel = new PowerDatagramChannel(transport, {
  maxDatagramSizeBytes: 64 * 1024,
  maxQueue: 128,
  onError: (err, ctx) => log.warn({ err, ctx }, 'datagram refused'),
});

channel.send(new Uint8Array([1, 2, 3]));
channel.close();
```

`readyState` is read from the transport as `'open'` or `isOpen === true`. A
transport that exposes neither is assumed open, because the alternative is
refusing every datagram by default.

## Flush

`flush()` drains the internal queue to the transport. Call it when the transport
transitions to open, or periodically while it is open. It returns the number of
datagrams successfully sent.

Oversize datagrams already in the queue are counted in `oversizeDatagrams` and
discarded — they never reach the transport. Datagrams that the transport throws
on are left in the queue for the next flush, and `errorCount` is incremented.

## Options

| Option                 | Type                            | Default     | Description                                                                                                                                                                                       |
| ---------------------- | ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onError`              | `Function`                      | `undefined` | Called when the underlying transport throws or when an oversize datagram is refused. Receives `(err, ctx)` where `ctx` includes `channel` and, for oversize refusals, `datagramSize` and `limit`. |
| `maxDatagramSizeBytes` | `number`                        | `65535`     | Hard ceiling on outbound datagram size. A datagram larger than this is refused with a `TypeError` before it reaches the transport. `0` disables the check.                                        |
| `maxQueue`             | `number`                        | `64`        | Maximum datagrams buffered for sending when the transport is not ready. `0` disables queueing: a datagram arriving while the transport is closed is refused immediately.                          |
| `observability`        | `boolean` \| `MetricsCollector` | `false`     | Opt in to metrics: `true` registers under the prefix `datagramChannel`, or pass a collector of your own. See `guides/metrics.md`.                                                                 |

An unrecognised option **throws** rather than being ignored.

## API

| Member                             | Returns   | Notes                                                                                                                                                                                            |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send(datagram)`                   | `boolean` | `true` when the datagram was accepted (sent or queued). **Throws** `TypeError` for a datagram over `maxDatagramSizeBytes`. Returns `false` when the transport is not ready or the queue is full. |
| `flush()`                          | `number`  | Sends every queued datagram that fits under the size limit. Returns the count of datagrams successfully sent. Oversize queued datagrams are counted and discarded.                               |
| `close()`                          | `void`    | Stops accepting new datagrams and flushes the internal queue one last time. Does not close the underlying transport — that is the caller's responsibility. Safe to call more than once.          |
| `dispose()` / `[Symbol.dispose]()` | `void`    | Idempotent teardown. Detaches metrics, drops the transport reference, and empties the queue. Works with `using`.                                                                                 |
| `isOpen`                           | `boolean` | Whether the underlying transport looks open. Reads `transport.readyState === 'open'` or `transport.isOpen === true`, falling back to `true` when neither is present.                             |
| `stats()` / `getStats()`           | `object`  | Counters and configuration snapshot. Both names work.                                                                                                                                            |

`stats()` returns:

```js
{
  sentCount: number,        // datagrams successfully sent
  droppedCount: number,     // datagrams dropped from a full queue
  oversizeDatagrams: number,// datagrams refused for exceeding maxDatagramSizeBytes
  errorCount: number,       // transport throws during send or flush
  bytesOut: number,         // total bytes successfully sent
  queued: number,           // datagrams currently in the internal queue
  maxQueue: number,         // configured queue capacity
  maxDatagramSizeBytes: number, // configured size ceiling
  disposed: boolean,        // whether close() or dispose() was called
}
```

## Troubleshooting

| Symptom                                                        | Cause                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send()` always returns `false`, `stats().sentCount` is `0`    | The transport never opened. Check `isOpen` — a transport that does not expose `readyState` or `isOpen` is assumed open, so a `false` here means the transport explicitly reports closed.                                  |
| `droppedCount` climbing while `queued` stays at `maxQueue`     | The queue is full and every new datagram is dropping the oldest. Size `maxQueue` for the worst case, or fix the producer.                                                                                                 |
| `onError` with a `TypeError` mentioning `maxDatagramSizeBytes` | A datagram exceeded the size ceiling. It was stopped **before** `send()` — it never went on the wire. Bound the payload at the producer.                                                                                  |
| `oversizeDatagrams` climbing after a flush                     | Oversize datagrams were queued while the transport was closed, and `flush()` is now counting and discarding them. Either raise `maxDatagramSizeBytes` or prevent oversize datagrams from being queued in the first place. |
| `errorCount` climbing during flush                             | The transport is throwing on send. The failing datagrams are left in the queue for the next flush, so a transport that stays broken will see `errorCount` climb and `queued` stay constant.                               |

## See also

- [`PowerRTCChannel`](powerRTCChannel.md) — the hub-facing `RTCDataChannel` adapter, with `readyState` normalisation and SCTP message-size enforcement.
- [`PowerSocketAdapter`](powerSocketAdapter.md) — the same normalisation for `ws`, `WebSocket` and `WebSocketStream`.
- [`PowerRealtimeHub`](powerRealtimeHub.md) — the fan-out this class is **not** a transport for. Datagrams and `retain` contradict.
- [`PowerMessageCodec`](powerMessageCodec.md) — the framed codec the hub uses. Datagrams bypass it entirely.
