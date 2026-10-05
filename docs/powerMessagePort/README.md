[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerMessagePort

# powerMessagePort

PowerMessagePort — a `MessagePort` transport adapter for `PowerRealtimeHub`.

A `MessagePort` is the one transport where the **native** structured-clone
codec applies losslessly: `Map`, `Set`, `Date`, `BigInt` and cycles survive
the boundary without `JSON.stringify`-ing them into `{}` or an ISO string.
This class exists so the hub's `send(sub, frame)` / `close(sub)` contract
can be satisfied by a port, and so inbound messages are decoded through
`decodeInbound` — the same half the pool uses for native-carrier workers.

## Why this is a separate class and not a two-line arrow function

The hub's `send` adapter is called as `send(sub, frame)` where `frame` is
the hub's own encoded `Uint8Array`. A bare `(sub, frame) => port.postMessage(frame)`
works for outbound, but inbound needs three things the arrow does not give
you:

1. `decodeInbound` on every `onmessage` payload, so a native envelope is
   unpacked before it reaches the subscriber's handler.
2. Listener cleanup on `dispose()` — a port that outlives its adapter leaks
   the handler closure, and a second `dispose()` must not throw.
3. A `close()` that is safe to call more than once and safe on a port that
   closed first.

## Classes

- [PowerMessagePort](classes/PowerMessagePort.md)

## Interfaces

- [PowerMessagePortOptions](interfaces/PowerMessagePortOptions.md)
