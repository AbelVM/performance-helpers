[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSocketAdapter](../README.md) / PowerSocketAdapter

# Class: PowerSocketAdapter

PowerSocketAdapter

 PowerSocketAdapter

## Example

```ts
// Node `ws` server side.
const adapter = new PowerSocketAdapter(ws, {
  heartbeatIntervalMs: 30_000,
  onMessage: (msg) => handle(msg.data),
  rateLimit: { limit: 100, windowMs: 1_000 },
});
server.on('connection', (ws) => new PowerSocketAdapter(ws, handlers));
```

## Constructors

### Constructor

> **new PowerSocketAdapter**(`socket`, `options?`): `PowerSocketAdapter`

#### Parameters

##### socket

`any`

A Node `ws` socket, a browser `WebSocket`, or a
  `WebSocketStream`.

##### options?

`PowerSocketAdapterOptions` = `...`

#### Returns

`PowerSocketAdapter`

## Properties

### \_closedByUser

> **\_closedByUser**: `boolean`

***

### \_counters

> **\_counters**: `object`

#### backpressureEvents

> **backpressureEvents**: `number` = `0`

#### drained

> **drained**: `number` = `0`

#### drainedFromDrain

> **drainedFromDrain**: `number` = `0`

#### drainTimeouts

> **drainTimeouts**: `number` = `0`

#### handled

> **handled**: `number` = `0`

#### heartbeatTimeouts

> **heartbeatTimeouts**: `number` = `0`

#### idleTimeouts

> **idleTimeouts**: `number` = `0`

#### messages

> **messages**: `number` = `0`

#### rateLimited

> **rateLimited**: `number` = `0`

#### sendFailures

> **sendFailures**: `number` = `0`

#### sent

> **sent**: `number` = `0`

***

### \_detached

> **\_detached**: (() => `void`) \| (() => `void`) \| `null`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_draining

> **\_draining**: `boolean`

***

### \_drainPromise

> **\_drainPromise**: `Promise`\<`boolean`\> \| `null`

***

### \_drainTimeoutMs

> **\_drainTimeoutMs**: `number`

***

### \_drainTimer

> **\_drainTimer**: `number` \| `null`

***

### \_drainWaiters

> **\_drainWaiters**: (`ok`) => `void`[]

#### Parameters

##### ok

`boolean`

#### Returns

`void`

***

### \_heartbeatDeadline

> **\_heartbeatDeadline**: `number` \| `null`

***

### \_heartbeatIntervalMs

> **\_heartbeatIntervalMs**: `number`

***

### \_heartbeatTimeoutMs

> **\_heartbeatTimeoutMs**: `number`

***

### \_heartbeatTimer

> **\_heartbeatTimer**: `number` \| `null`

***

### \_idleTimeoutMs

> **\_idleTimeoutMs**: `number`

***

### \_idleTimer

> **\_idleTimer**: `number` \| `null`

***

### \_lastActivityAt

> **\_lastActivityAt**: `number`

***

### \_limiter

> **\_limiter**: [`PowerSlidingWindow`](../../powerSlidingWindow/classes/PowerSlidingWindow.md) \| `null`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_onClose

> **\_onClose**: ((`arg0`) => `void`) \| `null`

***

### \_onError

> **\_onError**: ((`arg0`, `arg1`) => `void`) \| `null`

***

### \_onMessage

> **\_onMessage**: ((`arg0`) => `void` \| `Promise`\<`void`\>) \| `null`

***

### \_onOpen

> **\_onOpen**: ((`arg0`) => `void`) \| `null`

***

### \_onRateLimited

> **\_onRateLimited**: `PowerSocketAdapterRateLimited` \| `null`

***

### \_pending

> **\_pending**: `number`

***

### \_pingSentAt

> **\_pingSentAt**: `number`

***

### \_pumpStream

> **\_pumpStream**: (() => `Promise`\<`void`\>) \| `undefined`

***

### \_rateLimitAction

> **\_rateLimitAction**: `string`

***

### \_state

> **\_state**: `any`

***

### \_streamPromise

> **\_streamPromise**: `Promise`\<`void`\> \| `undefined`

***

### \_streamReader

> **\_streamReader**: `any`

***

### \_streamRetryDelay

> **\_streamRetryDelay**: `number`

***

### \_streamRetryTimer

> **\_streamRetryTimer**: `any`

***

### \_streamWritePending

> **\_streamWritePending**: `number`

***

### \_streamWriter

> **\_streamWriter**: `any`

The single `WebSocketStream` writer, acquired on first send and held
until dispose. See `_writeStream` for why it cannot be per-call.

***

### kind

> **kind**: [`SocketKind`](../type-aliases/SocketKind.md)

***

### socket

> **socket**: `any`

## Accessors

### bufferedAmount

#### Get Signature

> **get** **bufferedAmount**(): `number`

Bytes buffered by the transport, for the `bufferedAmount` watermark.

Always `0` for a `WebSocketStream`, which has no `bufferedAmount` because
it provides real backpressure through `writer.ready` instead. Reporting 0
rather than `NaN` or `Infinity` is deliberate: a caller polling a watermark
would treat those as "never backed up" and never pause.

##### Returns

`number`

***

### canPing

#### Get Signature

> **get** **canPing**(): `boolean`

Whether the transport exposes a usable `ping()`.

Node `ws` does; browsers do not, because the API is deliberately not
exposed to script. `WebSocketStream` does not either. When this is `false`
the adapter cannot run a protocol-level heartbeat, and the liveness signal
it falls back to is message activity — see
[PowerSocketAdapter#stats](#stats).

##### Returns

`boolean`

***

### isDraining

#### Get Signature

> **get** **isDraining**(): `boolean`

Whether [PowerSocketAdapter#drain](#drain) has been called.

##### Returns

`boolean`

***

### isOpen

#### Get Signature

> **get** **isOpen**(): `boolean`

Whether the socket is open and not draining.

##### Returns

`boolean`

***

### readyState

#### Get Signature

> **get** **readyState**(): `number`

The socket's lifecycle state, as a `READY_STATE` constant.

A `WebSocketStream` has no `readyState` at all, so it reports `OPEN` for
its whole life and `CLOSED` after [PowerSocketAdapter#close](#close). This is
a real difference in fidelity, not a normalisation that loses information:
a stream's liveness is observable through its reader, not its state.

##### Returns

`number`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerSocketAdapter#dispose](#dispose-1), so `using` works.

#### Returns

`void`

***

### close()

> **close**(`code?`, `reason?`): `void`

Close the socket.

Safe to call more than once, and on a socket in any state — the underlying
`ws` throws on a double close in some versions, which is exactly the kind
of thing a shutdown path should not have to know.

#### Parameters

##### code?

`number` = `1000`

Close code.

##### reason?

`string` = `''`

Close reason.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Detach every listener and cancel every timer.

Required rather than tidy: a `ws` socket outliving its adapter keeps the
adapter's closures alive, and a server that never disposes on disconnect
leaks one adapter per connection for the life of the process.

#### Returns

`void`

***

### drain()

> **drain**(`code?`, `reason?`): `Promise`\<`boolean`\>

Stop accepting work, let what is in flight finish, then close.

This is the difference between a deploy that drops a thousand in-flight
requests and one that does not. The sequence is:

1. `isOpen` becomes `false` and `send()` refuses, so a producer stops
   immediately rather than queueing into a socket that is about to close.
2. In-flight `onMessage` handlers are allowed to settle.
3. The socket is closed, and the promise resolves.

Step 3 is bounded by `drainTimeoutMs`, because a handler that never settles
would otherwise hold a deploy open forever. A drain that times out reports
`drainTimeouts` in [PowerSocketAdapter#stats](#stats) rather than pretending
it finished cleanly.

#### Parameters

##### code?

`number` = `1000`

Close code.

##### reason?

`string` = `''`

Close reason.

#### Returns

`Promise`\<`boolean`\>

`true` when everything settled in time, `false`
  on timeout.

***

### getStats()

> **getStats**(): `object`

Alias for [stats](#stats), so a caller who learned `getStats()` from
`PowerPool` — the one class that has always spelled it this way — is not
handed `TypeError: x.getStats is not a function` here.

Nine helpers spell the reporting method `stats()` and `PowerPool` spelled it
`getStats()`, with no stated rule and nothing pinning it, which reached the
documentation as a false claim (`guides/metrics.md`, `llm.txt`). Both
spellings work everywhere now. `stats()` is canonical and this delegates to
it; `PowerPool` keeps `getStats` because renaming the largest surface in the
library would be a breaking change.

Written out per class rather than installed on the prototype on purpose: a
dynamic `Object.defineProperty` is invisible to `tsc`, so the generated
`types/` omitted it and a TypeScript caller got a type error on a method
that worked at runtime. That was the first implementation.

**No `@returns` tag, and that is load-bearing.** The first version carried a
hand-copied copy of the `stats()` return shape, on the reasoning that an
explicit type was safer. It is not: the copy went stale the moment a
concurrent change added `staleServes` and `expirations` to `PowerCache`
`.stats()`, and `test/statsNaming.test.js` failed. Inference gives a
byte-identical published type and cannot drift, because there is nothing to
keep in sync. `test/types.test-d.ts` asserts the two are mutually assignable,
which is the property a consumer relies on.

#### Returns

`object`

***

### send()

> **send**(`data`): `boolean`

Send data over the socket.

#### Parameters

##### data

`string` \| `ArrayBuffer` \| `ArrayBufferView`\<`ArrayBufferLike`\>

#### Returns

`boolean`

`false` when the socket is not open, is draining, or is
  disposed. Never throws for an ordinary "cannot send right now" — a send
  loop that has to try/catch every call is a send loop that will eventually
  swallow a real error.

***

### stats()

> **stats**(): `object`

Counters, plus the liveness mode actually in use.

#### Returns

`object`
