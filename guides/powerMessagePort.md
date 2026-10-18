# PowerMessagePort

A `MessagePort` transport adapter for `PowerRealtimeHub`.

A `MessagePort` is the one transport where the **native** structured-clone codec applies losslessly: `Map`, `Set`, `Date`, `BigInt` and cycles survive the boundary without `JSON.stringify`-ing them into `{}` or an ISO string. This class exists so the hub's `send(sub, frame)` / `close(sub)` contract can be satisfied by a port, and so inbound messages are decoded through `decodeInbound` — the same half the pool uses for native-carrier workers.

## Why this is a separate class and not a two-line arrow function

The hub's `send` adapter is called as `send(sub, frame)` where `frame` is the hub's own encoded `Uint8Array`. A bare `(sub, frame) => port.postMessage(frame)` works for outbound, but inbound needs three things the arrow does not give you:

1. `decodeInbound` on every `onmessage` payload, so a native envelope is unpacked before it reaches the subscriber's handler.
2. Listener cleanup on `dispose()` — a port that outlives its adapter leaks the handler closure, and a second `dispose()` must not throw.
3. A `close()` that is safe to call more than once and safe on a port that closed first.

## Usage

```javascript
import { PowerRealtimeHub, PowerMessagePort, decodeMessage } from 'performance-helpers';

const hub = new PowerRealtimeHub({
  send: (sub, frame) => sub.transport.send(frame),
  close: (sub, reason) => sub.transport.close(),
  onError: (err) => log.error({ err }, 'send failed'),
});

// A `MessagePort` from a `Worker`, `BroadcastChannel`, or `MessageChannel`.
const port = new MessagePort();
// ... wire the port to the hub ...
const transport = new PowerMessagePort(port, {
  onMessage: (value, correlationId) => handle(value),
  onClose: () => log.warn('port closed'),
  onError: (err) => log.error({ err }, 'decode failed'),
});

hub.subscribe('ticks', onTick, { transport });
```

## Constructor

| option          | type                             | default      | description                                                                                                                                                                        |
| --------------- | -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `port`          | `MessagePort`                    | _(required)_ | An open or opening `MessagePort`. The adapter attaches listeners immediately; a port that is not yet `open` queues messages until it is, which is the platform's normal behaviour. |
| `onMessage`     | `function(value, correlationId)` | —            | Called with the decoded `value` and optional `correlationId` for each inbound message.                                                                                             |
| `onClose`       | `function()`                     | —            | Called when the port closes.                                                                                                                                                       |
| `onError`       | `function(Error)`                | —            | Called when an inbound message cannot be decoded.                                                                                                                                  |
| `observability` | `boolean` \| `MetricsCollector`  | `false`      | Opt in to metrics. See [Metrics](metrics.md).                                                                                                                                      |

## API

- `new PowerMessagePort(port, options)` — wraps an open or opening `MessagePort`. Attaches listeners immediately; a port that is not yet `open` queues messages until it is, which is the platform's normal behaviour.
- `send(sub, frame)` — posts the hub's encoded `Uint8Array` frame to the port. Returns `false` when the adapter is already disposed.
- `close()` — detaches listeners and closes the port. Safe to call more than once.
- `dispose()` / `[Symbol.dispose]()` — idempotent teardown. Drops the port reference so the handler closure does not keep the adapter alive.
- `stats()` / `getStats()` — minimal metrics snapshot: `sentCount`, `receivedCount`, `errorCount`, `state`, `disposed`.

## Notes

- The adapter does **not** frame outbound messages. The hub's own `PowerMessageCodec` frame is posted as-is; the port's structured-clone boundary handles the serialisation.
- Inbound frames are decoded through `decodeInbound`, which accepts both native envelopes and framed `Uint8Array` messages. A truncated or corrupt frame calls `onError` with a `RangeError` rather than throwing into the port's event loop.
- `observability: true` opts this helper into the shared `MetricsCollector`. The prefix is `messagePort`.

## Transfer ports (zero-copy handoff)

`send`, `postMessage` and `transferPort` accept an optional transfer list so
transferable objects (such as `ArrayBuffer`s or `MessagePort`s) can be handed
over zero-copy instead of being structured-cloned:

```js
const adapter = new PowerMessagePort(port);

// Hand a frame's backing buffer to the peer without copying.
const frame = new Uint8Array([1, 2, 3]);
adapter.send({}, frame, [frame.buffer]);

// Hand an arbitrary value (e.g. a port) to the peer.
const channel = new MessageChannel();
adapter.postMessage(channel.port2, [channel.port2]);

// Convenience wrapper for the common case.
adapter.transferPort(channel.port2);
```

- `send(sub, frame, transfer = [])` — posts the hub's frame, forwarding `transfer` to the platform's `postMessage`.
- `postMessage(value, transfer = [])` — posts an arbitrary value with an optional transfer list.
- `transferPort(port)` — transfers a single `MessagePort` zero-copy.

All three return `false` when the adapter is already disposed.

## Cleanup with `using`

`PowerMessagePort` implements `Symbol.dispose` / `Symbol.asyncDispose`:

```javascript
{
  using port = new PowerMessagePort(channel);
  port.postMessage({ hello: 'world' });
} // port.dispose() runs here — port closed
```
