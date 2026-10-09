# PowerRealtimeHub

Topic fan-out with **per-subscriber bounded queues** and an **explicit slow-consumer policy**.

The naive way to push to a set of clients is:

```js
for (const ws of clients) ws.send(payload);
```

That fails in two ways that only surface in production:

1. **One slow consumer stalls everyone.** A single client's TCP buffer fills, its `send` starts buffering without bound, and that backlog consumes the memory of the whole process. Eventually the server dies for everyone because of one bad connection.
2. **Nothing tells you it happened.** There is no signal that a client has fallen behind, so you cannot shed load deliberately.

This hub gives every subscription its own bounded queue and a _declared_ policy for when that queue fills. A slow consumer becomes a bounded, observable, per-subscriber problem instead of a process-wide one.

## Transport-agnostic

The hub knows nothing about WebSockets. You supply a `send(subscriber, frame)` adapter, so it works with a `WebSocket`, a Node `ws` socket, a `MessagePort`, a stream writer, or a test spy.

```javascript
import { PowerRealtimeHub } from 'performance-helpers/powerRealtimeHub';

const hub = new PowerRealtimeHub({
  send: (sub, frame) => sub.socket.send(frame),
  close: (sub, reason) => sub.socket.close(1000, reason),
  onError: (err, sub) => console.warn('send failed', sub.id, err),
});
```

Messages are encoded with [`PowerMessageCodec`](powerMessageCodec.md), so several can be batched into one `send` and the receiver still knows exactly where each message ends.

### The frame is read-only

**One frame is encoded per `(topic, batch)` and handed to every subscriber on
that topic.** On a fan-out to 5 000 subscribers that is 5 000 encodes collapsed to
one — the encode was measured at 92 % of the flush — so the same `Uint8Array`
reaches 5 000 `send` calls.

A `send` adapter must therefore **treat `frame` as read-only**. Writing into it
corrupts every other subscriber's message, and it is the kind of bug that shows
up as one subscriber's data appearing in another's stream rather than as an
error:

```javascript
// Wrong — `frame` is shared with every other subscriber on this topic.
send: (sub, frame) => sub.socket.send(frame.subarray(0, 6));

// Right — copy if the transport needs to own the buffer.
send: (sub, frame) => sub.socket.send(frame.slice());
```

`WebSocket.send()` and `WritableStreamDefaultWriter.write()` both treat their
argument as read-only, so passing the frame straight through — as the adapter
above does, and as `PowerWebSocketClient.sendFrame()` does — is correct.

`stats().encoded` is the observable half: it counts real encodes, so it stays at
**one per flush** however many subscribers the topic has. A count that climbs with
the subscriber count means a transport is mutating frames or the memo is missing
hits; both are bugs, and neither raises an error.

## Slow-consumer policies

Set per subscription via `slowConsumer`:

| policy                    | behaviour                                                      | use when                                                                                   |
| ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `drop-oldest` _(default)_ | discard the oldest queued message to make room for the new one | chat / log feeds where the latest state matters most                                       |
| `drop-newest`             | refuse the incoming message, keep what is queued               | ordered, replay-sensitive streams                                                          |
| `disconnect`              | close the subscriber once it falls behind                      | stale or missing data is worse than cutting the client loose to reconnect with fresh state |

`drop-oldest` is the default deliberately: it degrades a slow consumer into a _stale_ one rather than into a stalled server.

```javascript
const unsubscribe = hub.subscribe('trades', onTrade, {
  maxQueue: 128,
  slowConsumer: 'drop-oldest',
  id: 'client-42',
});
```

### `maxQueue: 0`

Capacity zero means no buffering at all — the policy is evaluated as each message arrives. Under `drop-oldest` with nothing queued there is no older message to evict, so the _incoming_ one is dropped. Delivery becomes effectively synchronous: if the transport is not ready, the message is not queued.

## Batching

`batch: true` (default) coalesces everything published in the same microtask into a single `send`, up to the subscriber's `maxBatch`. One `JSON.stringify` for the whole batch, one frame:

```javascript
const frames = [];
const hub = new PowerRealtimeHub({ send: (s, f) => frames.push(f) });
hub.subscribe('t', () => {});
for (let i = 0; i < 5; i++) hub.publish('t', i);
await hub.flush();
frames.length; // 1
JSON.parse(new TextDecoder().decode(frames[0].slice(6))); // [0,1,2,3,4]
```

`batchDelayMs` widens the coalescing window beyond a single microtask. `batch: false` disables automatic flushing entirely, so the caller drives it with `flush()` — useful in tests and for transports that cannot take several frames at once.

The `raw` codec carries exactly one payload per frame, so it cannot also carry a batch boundary. A subscriber that could coalesce more than one is rejected at `subscribe()`, naming the option to change:

```js
new PowerRealtimeHub({ send, codec: 'raw' }).subscribe('t', handler);
// TypeError: `codec: "raw"` delivers one message per frame, so a subscriber
//            must use `maxBatch: 1`.
```

**`maxBatch: 1` is the only configuration that works**, and `batch: false` does _not_ rescue the default: the batch is taken off the queue before it is encoded, so a queue that accumulated two messages while unbatched still produces a two-message batch. That check lives in `subscribe()` rather than the constructor because `maxBatch` is a per-subscriber option — `raw` is perfectly legal, `maxBatch: 1` is the case the hub can honour, and `subscribe()` is the only place both facts are visible.

Beyond that, a payload `encodeMessage` cannot frame at all (a plain object under `raw`, say) is **counted in `dropped` and reported through `onError`**, not silently discarded. Re-queuing it was the obvious fix and is wrong: an encode failure is permanent, so the retry loop would spin and `flush()` would never resolve.

## Back-pressure, honestly

The handler is invoked **after** the transport accepts the batch, so a slow socket genuinely back-pressures instead of racing ahead of it. A subscriber with a full queue is not drained further while a send is still in flight.

What this does **not** do is know your socket's high-water mark. For a `WebSocket` you should additionally gate on `bufferedAmount` — that is [`PowerWebSocketClient`](powerWebSocketClient.md)'s job, and pairing the two is the recommended setup.

## Constructor

```javascript
const hub = new PowerRealtimeHub({ send, close });
```

| Option            |                         Type                          | Default  | What it means                                                                         |
| ----------------- | :---------------------------------------------------: | :------: | ------------------------------------------------------------------------------------- |
| `send`            | `function(object, Uint8Array): void \| Promise<void>` |    —     | **Required.** Hands one frame to your transport. Awaited, so back-pressure is real.   |
| `observability`   |             `boolean \| MetricsCollector`             | `false`  | Register with the shared `MetricsCollector`, or with one you pass.                    |
| `close`           |   `function(object, string): void \| Promise<void>`   |          | Called with a reason on teardown: `'unsubscribe'`, `'slow-consumer'`, `'hub-closed'`. |
| `batch`           |                       `boolean`                       |  `true`  | Coalesce messages published within the same tick into one frame.                      |
| `batchDelayMs`    |                       `number`                        |   `0`    | Macrotask delay before sending, so a burst becomes one frame.                         |
| `codec`           |                  `'json'` \| `'raw'`                  | `'json'` | Payload codec for outgoing frames.                                                    |
| `onError`         |            `function(Error, object): void`            |          | Called when `send` rejects. Without it the rejection is silent.                       |
| `messagePriority` |                       `boolean`                       | `false`  | Order each subscriber's queue by the `priority` given to `publish()`. See below.      |

An unrecognised option throws — every helper in this library validates its
options against this list.

## API

- `subscribe(topic, handler, options)` → `unsubscribe()`. Options: `maxQueue` (default 64), `slowConsumer`, `maxBatch` (default 32), `id`, `transport`, `priority`, `bytesAcknowledged`.
- `publish(topic, message, { retain, priority })` → number of subscribers queued for. `retain: true` keeps the message for later subscribers, in a log bounded to 32 per topic. `priority` orders the message within each subscriber's queue and requires the hub's `messagePriority` option — passing it without that throws.

  The replay is real and works whether or not anyone was listening when you published — publishing into a topic with no subscribers is the case this option exists for. A new subscriber receives the retained log in publish order, **through the same queue and the same slow-consumer policy as any live delivery**, so a subscriber whose `maxQueue` cannot hold the log drops it by the rules it chose rather than by a second, quieter mechanism. A replay does **not** increment `published`: it is not a publication, and counting it would make that counter jump by the length of every retained log on every `subscribe`. The log is released when the **last** subscriber on that topic leaves — one subscriber unsubscribing does not destroy the history the others still depend on — and `close()` releases the rest.

- `flush()` → `Promise<void>`, drains every subscriber immediately, bypassing batching. Resolves once every subscriber's queue has reached the transport — including a subscriber that already had a send in flight, which is **waited for** rather than skipped.
- **One frame at a time per subscriber.** A second frame is not handed to the transport while the previous one is still outstanding, so frames for one subscription reach it in the order they were published. Work that arrives meanwhile waits for the outstanding send and is then drained; it is never dropped and never reordered.
- `unsubscribe(id)` → `boolean`.
- `stats()` → `{ subscribers, topics, published, delivered, dropped, disconnected, bytesOut, encoded, list }`, where `list` has per-subscriber `queued` / `dropped` / `bytesSent` / `inFlight`. `encoded` counts frame encodes rather than deliveries, so it is one per flush and does not grow with the subscriber count — see [the frame is read-only](#the-frame-is-read-only).
- `close()` / `[Symbol.dispose]()` — detaches everything and calls your `close` adapter with a reason (`'unsubscribe'`, `'slow-consumer'`, `'hub-closed'`).
- `await hub[Symbol.asyncDispose]()` — **flushes the pending batch, then closes**. The difference is not cosmetic, and it is the reason `await using` exists for this helper:

  ```javascript
  {
    await using hub = new PowerRealtimeHub(adapter, { batchDelayMs: 50 });
    hub.subscribe('room', handler);
    hub.publish('room', { n: 1 });
  } // the frame is flushed, then everything is detached
  ```

  | teardown                          | frames sent at scope exit            |
  | --------------------------------- | ------------------------------------ |
  | `using` (sync `[Symbol.dispose]`) | **0** — the pending batch is dropped |
  | `await using`                     | **1**                                |

  `close()` is not graceful: it clears the pending batch along with everything
  else, so a frame that `stats()` counted as `published` may never be delivered.
  If your hub batches, `await using` is the correct form — and note that plain
  `using hub = ...` would leave the hub **undisposed entirely**, because
  `await using` requires `asyncDispose` and silently does nothing without it.

  A flush that fails still closes the hub. That is deliberate: leaving it open
  with listeners attached would be worse than losing the batch.

## Observability

The counters that matter for a slow-consumer problem are `dropped` and `disconnected`. Alert on them: a non-zero `dropped` rate means clients are falling behind, and a non-zero `disconnected` means you are actively cutting them loose.

```javascript
setInterval(() => {
  const s = hub.stats();
  if (s.dropped)
    console.warn(
      'slow consumers:',
      s.list.filter((x) => x.dropped > 0)
    );
}, 10_000);
```

### Per-subscriber bytes

Each entry in `list` carries `bytesSent`: the bytes of framed payload handed to **that** subscriber's transport so far. It is exact, and it is free — the frame was built for the flush anyway, and because one frame is shared across a topic, `bytesSent` is the same figure for every subscriber on it. Use it with `queued` and `dropped` together, which is the combination that separates the two reasons a subscriber is not keeping up:

| `queued` | `bytesSent` | `dropped` | what it means                                             |
| -------- | ----------- | --------- | --------------------------------------------------------- |
| low      | flat        | 0         | healthy — nothing is accumulating                         |
| high     | flat        | 0         | the transport is slow; the hub is buffering, not shedding |
| low      | flat        | > 0       | falling behind and **already** losing messages            |

Two things it is not. It is **not** a count of what is sitting in the queue: `queued` already counts that, in messages, and counting it in bytes would mean encoding every message twice. And it is **not** what a `send()` that _threw_ produced — the counter moves only once the adapter has taken the frame, so a transport that rejects synchronously adds nothing. That is the one place it disagrees with `delivered`, which counts messages _offered_ rather than taken.

The two reconcile, which is what makes the per-subscriber number worth trusting:

```javascript
hub.stats().bytesOut === hub.stats().list.reduce((n, s) => n + s.bytesSent, 0); // true
```

### `bytesAcknowledged` — transport-reported acknowledgement

`bytesSent` counts bytes the hub **handed to the adapter**. On HTTP/2 a transport
reports per-stream acknowledgement, which is a strictly better figure — it
counts bytes the peer has actually received, not bytes the hub offered. So
`subscribe()` accepts an optional `bytesAcknowledged` callback:

```javascript
hub.subscribe('prices', handler, {
  bytesAcknowledged: (bytes, sub) => gauge.set(sub.id, bytes),
});
```

It is a **function, not a number** — a value captured at subscribe time would be
stale by the next flush. The hub invokes it in the same statement that increments
`bytesSent`, so the two move together, and it is **per-subscriber**: a callback
wired up for one subscriber is never invoked for another.

It is optional and the normal case is to omit it. The hub keeps `bytesSent` as
the floor, so on transports that do not report acknowledgement nothing changes —
the callback is simply not supplied. `null` is accepted as an explicit
"not supplied" sentinel, and a non-function is rejected at subscribe time: it
would be invoked after every flush and would throw, turning a routine delivery
into an unhandled rejection. A callback that throws is reported through `onError`
rather than breaking delivery, because a bad accounting callback must not become
a delivery failure.

### `priority` — drain order

`subscribe()` accepts a `priority` number (default `0`). On every flush,
subscribers with queued work are visited **highest priority first**, ties broken
by insertion order. It is a number, not a name, and the hub does not weight or
decay it — so a caller who sets one subscriber to `1` and everything else to `0`
has granted that subscriber a permanent advantage. The starvation risk is real
either way, and it is the reason `priority` is a number rather than a label: a
hot source stays hot until the caller changes it.

```javascript
hub.subscribe('alerts', handler, { priority: 10 }); // served before priority-0 peers
```

`stats().list` reflects `priority` back rather than re-deriving it: it is a value
the caller supplied, so reporting it is honest and recomputing it would be
inventing one.

### `messagePriority` — message order

`priority` above decides **which subscriber is served first**. `messagePriority`
decides **which message a subscriber receives next**, and it is a separate,
opt-in hub option:

```javascript
const hub = new PowerRealtimeHub({ send, messagePriority: true });

hub.publish('alerts', { level: 'info' }, { priority: 1 });
hub.publish('alerts', { level: 'critical' }, { priority: 10 });
// the subscriber receives `critical` first
```

Off by default, so the common case stays a plain array with FIFO delivery and
pays nothing. When on, every subscriber's queue is a `PowerPriorityQueue`, and
`publish()` accepts a `priority` — higher first, ties broken by arrival order, so
an omitted priority behaves exactly like an explicit `0`.

Passing `priority` to `publish()` on a hub **without** `messagePriority` throws.
That is deliberate: an ordering that is silently ignored is the misspelled-option
failure this library refuses to have, and the caller would otherwise believe they
had asked for priority and receive FIFO.

The hub does not read ordering out of your payload. A message that happens to
carry a `priority` field is not reordered unless you pass the option explicitly.

#### What changes under `drop-oldest`

This is the one place the two modes disagree, and it is worth being precise about.

In fifo mode, `drop-oldest` discards the **head** of the queue — the message
nearest to delivery. Under `messagePriority` it discards the message **furthest**
from delivery: lowest priority, and among equal priorities the most recently
queued.

The two agree about which _priority class_ loses — the least valuable one — and
disagree only about the tie. Evicting the best queued message instead, which is
what a naive `shift()` in the eviction path would do, throws away exactly the
traffic the ordering existed to protect: a slow consumer would lose the urgent
messages and keep the junk.

```javascript
// maxQueue: 2, messagePriority: true
hub.publish('t', { n: 'critical' }, { priority: 10 });
hub.publish('t', { n: 'noise' }, { priority: 1 });
hub.publish('t', { n: 'also-noise' }, { priority: 0 });
// `noise` loses its slot; `critical` and `also-noise` are delivered
```

`drop-newest` and `disconnect` are unchanged: a high-priority arrival does not
get to evict a lower-priority one under `drop-newest`, because that policy is
about protecting what is already queued.

## Example

```javascript
import { PowerRealtimeHub } from 'performance-helpers';

const hub = new PowerRealtimeHub({
  send: (sub, frame) => sub.socket.send(frame),
  close: (sub, reason) => sub.socket.close(1013, reason), // 1013 = try again later
  onError: (err, sub) => console.error('send', sub.id, err),
});

function addClient(socket, id) {
  return hub.subscribe('prices', (msg) => render(msg), {
    id,
    maxQueue: 32,
    slowConsumer: 'disconnect',
    transport: { socket },
  });
}

// One bad connection can no longer take the process down.
for (const client of clients) addClient(client.socket, client.id);
hub.publish('prices', { btc: 42_000 });

// Shutdown.
hub.close();
```

## Built-in adapters

### `PowerMessagePort`

`PowerMessagePort` wraps a `MessagePort` (or any object with the same event
shape) and presents the `send` / `close` interface the hub expects. It is the
recommended adapter when the transport is a `MessageChannel`, a `Worker` port,
or a `BroadcastChannel`-style boundary that exposes `postMessage` / `close`.

```javascript
import { PowerRealtimeHub, PowerMessagePort } from 'performance-helpers';

const port1 = new MessageChannel().port1;
const port2 = new MessageChannel().port2;

const hub = new PowerRealtimeHub({
  send: (sub, frame) => sub.adapter.send({}, frame),
  close: (sub, reason) => sub.adapter.close({ reason }),
});

const sub = hub.subscribe('room', (msg) => render(msg), {
  id: 'client',
  transport: { adapter: new PowerMessagePort(port2, { onMessage: render }) },
});

port1.postMessage(encodeNativeEnvelope({ text: 'hello' }));
```

The adapter owns the listener lifecycle: it attaches `onmessage`,
`onmessageerror` and `onclose` on construction and removes them on
`dispose()` / `[Symbol.dispose]()`. `close()` is idempotent. After
`dispose()`, inbound messages and close events are ignored.

### `PowerWebSocketClient`

[`PowerWebSocketClient`](powerWebSocketClient.md) is the WebSocket-specific
adapter. It pairs with the hub the same way and adds `bufferedAmount`
back-pressure on top.

## Notes

- Subscriber `id`s must be unique; a duplicate throws. Generate them from your connection identity, not a counter, so a reconnect gets a fresh subscription.
- A `send` adapter that throws or rejects is reported through `onError` and does not affect other subscribers.
- A throwing `handler` is likewise isolated and reported, rather than taking down the flush for everyone.
- `publish` after `close()` returns `0`; `subscribe` after `close()` throws.

## Validation

`batchDelayMs` is validated. `0` means "flush the batch immediately" and is kept.
A negative delay is not a fast flush — it is a `setTimeout` that fires
immediately by accident — and a `NaN` previously reached `0` through
`Number(x) || 0`, so a caller who passed a computed value got immediate
flushing and would have looked for the bug in the hub rather than in the
argument. Both now throw.
