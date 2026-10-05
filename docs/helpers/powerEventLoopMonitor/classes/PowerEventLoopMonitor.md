[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerEventLoopMonitor](../README.md) / PowerEventLoopMonitor

# Class: PowerEventLoopMonitor

Measure how long the event loop is unavailable.

Latency has a floor, and nothing in this library can tell you why latency
rose. A `PowerHistogram` of your own operation timings shows *that* it rose;
this shows whether the host was busy. A p99 that tracks your database's p99
is a different problem from a p99 that only degrades once a minute, and the
two look identical from inside the operation.

The measurement is timer drift: a timer is scheduled for `intervalMs` in the
future, and when it actually runs the gap is the event loop having been
unavailable. That is the same technique Node's own diagnostics use, and it
catches the case that matters most - a synchronous block - because the timer
simply cannot fire until the block finishes.

`utilization()` is separate and optional: it reports Node's
`eventLoopUtilization()` when the runtime has it (Node >= 14.5) and `null`
everywhere else. The Node built-in is resolved lazily through an opaque
dynamic import so bundlers never try to resolve `node:perf_hooks`; await
[PowerEventLoopMonitor#ready](#ready) before the first read if you need it
populated.

## Example

```ts
const monitor = new PowerEventLoopMonitor({ intervalMs: 20 });
monitor.start();
setInterval(() => {
  const s = monitor.stats();
  if (s.p99 > 50) console.warn('event loop blocked', s.max);
}, 5000);
// monitor.dispose() when done

@class PowerEventLoopMonitor
@public
```

## Constructors

### Constructor

> **new PowerEventLoopMonitor**(`options?`): `PowerEventLoopMonitor`

#### Parameters

##### options?

`EventLoopMonitorOptions` = `{}`

#### Returns

`PowerEventLoopMonitor`

## Properties

### \_blocked

> **\_blocked**: `number`

***

### \_blockedMs

> **\_blockedMs**: `number`

***

### \_delay

> **\_delay**: [`PowerHistogram`](../../powerHistogram/classes/PowerHistogram.md)

***

### \_dropped

> **\_dropped**: `number`

***

### \_handle

> **\_handle**: `any`

***

### \_keepProcessAlive

> **\_keepProcessAlive**: `boolean`

***

### \_lastDelay

> **\_lastDelay**: `number`

***

### \_max

> **\_max**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_onDrift

> **\_onDrift**: ((`arg0`) => `void`) \| `null`

***

### \_running

> **\_running**: `boolean`

***

### \_samples

> **\_samples**: `number`

***

### \_startedAt

> **\_startedAt**: `number`

***

### \_sum

> **\_sum**: `number`

***

### \_utilizationSource

> **\_utilizationSource**: (() => `any`) \| `null`

***

### intervalMs

> **intervalMs**: `number`

***

### ready

> **ready**: `Promise`\<`void`\>

Resolves once the Node `perf_hooks` lookup has settled, if it was
attempted. Never rejects: a runtime without it simply leaves
[PowerEventLoopMonitor#utilization](#utilization) returning `null`.

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Alias for [PowerEventLoopMonitor#reset](#reset).

`reset()` here *is* a clear — it discards every accumulated sample, so both
words describe the same act. Contrast the limiters, where `reset()` restores
a usable state and `clear()` would read as the opposite.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Stop sampling and release the timer. Safe to call more than once.

This is the only thing that unregisters the metrics receipt, and it is
terminal: after it, `getStats()` still answers but the monitor reports
nothing, because the collector no longer calls it.

#### Returns

`void`

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

##### active

> **active**: `boolean`

##### blockedMs

> **blockedMs**: `number`

##### blockedOver10ms

> **blockedOver10ms**: `number`

##### coverage

> **coverage**: `number` \| `null`

##### droppedSamples

> **droppedSamples**: `number`

##### intervalMs

> **intervalMs**: `number`

##### last

> **last**: `number`

##### max

> **max**: `number`

##### mean

> **mean**: `number` \| `null`

##### p50

> **p50**: `number` \| `null`

##### p99

> **p99**: `number` \| `null`

##### p99\_9

> **p99\_9**: `number` \| `null`

##### samples

> **samples**: `number`

***

### histogram()

> **histogram**(): [`PowerHistogram`](../../powerHistogram/classes/PowerHistogram.md)

The drift histogram. Owned by the monitor; do not call `reset()` on it
directly, use [PowerEventLoopMonitor#reset](#reset) so the counters agree.

#### Returns

[`PowerHistogram`](../../powerHistogram/classes/PowerHistogram.md)

***

### lastDelay()

> **lastDelay**(): `number`

The last recorded drift, in milliseconds. `0` before the first sample.

#### Returns

`number`

***

### reset()

> **reset**(): `void`

Clear all recorded samples, as if the monitor were brand new. Does not stop
sampling.

#### Returns

`void`

***

### start()

> **start**(): `PowerEventLoopMonitor`

Begin sampling. Idempotent: a second call while running is a no-op.

#### Returns

`PowerEventLoopMonitor`

***

### stats()

> **stats**(): `object`

Serializable snapshot of the configuration and the recorded samples.

`mean`, `p50`, `p99` and `p99_9` are `null` before the first sample rather
than `0`, so a consumer cannot mistake "not measured yet" for "no delay".
They are *estimates* - `PowerHistogram` is a DDSketch with a
`relativeAccuracy` bound - not exact quantiles.

#### Returns

`object`

##### active

> **active**: `boolean`

##### blockedMs

> **blockedMs**: `number`

##### blockedOver10ms

> **blockedOver10ms**: `number`

##### coverage

> **coverage**: `number` \| `null`

##### droppedSamples

> **droppedSamples**: `number`

##### intervalMs

> **intervalMs**: `number`

##### last

> **last**: `number`

##### max

> **max**: `number`

##### mean

> **mean**: `number` \| `null`

##### p50

> **p50**: `number` \| `null`

##### p99

> **p99**: `number` \| `null`

##### p99\_9

> **p99\_9**: `number` \| `null`

##### samples

> **samples**: `number`

***

### stop()

> **stop**(): `PowerEventLoopMonitor`

Stop sampling. In-flight samples already recorded are kept, so a stop/start
cycle does not lose history. Idempotent.

**This does not unregister the metrics receipt**, and that is the whole
point. It used to, which meant a stop/start cycle — the exact cycle this
method's own JSDoc invites, and one an app performs on a debug toggle or a
pause — left the monitor sampling and reporting nothing, permanently and
silently. `start()` does not re-attach, so there was no way back short of
constructing a new monitor and losing the collected history as well.
Eight other helpers detach in teardown only; this was the only one that
detached in a method documented as reversible. Use [PowerEventLoopMonitor#dispose](#dispose-1) to unregister.

#### Returns

`PowerEventLoopMonitor`

***

### utilization()

> **utilization**(): \{ `active`: `number`; `idle`: `number`; `utilization`: `number`; \} \| `null`

Node's `eventLoopUtilization()` reading, or `null` where the runtime does
not provide it.

`null` is a real answer, not a zero: outside Node there is no such
measurement, and reporting `0` would read as a perfectly idle loop. Await
[PowerEventLoopMonitor#ready](#ready) first, or pass a `utilizationProvider`.

#### Returns

\{ `active`: `number`; `idle`: `number`; `utilization`: `number`; \} \| `null`

***

### utilizationSince()

> **utilizationSince**(`previous`): \{ `active`: `number`; `elapsed`: `number`; `idle`: `number`; `ratio`: `number`; `utilization`: `number`; \} \| `null`

Event-loop utilisation over the interval between two readings.

**This is the half that makes the built-in worth reaching for**, and
[PowerEventLoopMonitor#utilization](#utilization) does not provide it. `utilization()`
hands back Node's *cumulative* reading — `active` and `idle` grow without
bound for the life of the process — so it answers "how busy has this process
been since it started", which is a lifetime average and barely moves. The
property ELU actually has, and the reason the row recommends it, is that it
is **defined over a measured interval**: subtract two readings and you have
that interval's active and idle time exactly.

Measured, and the reason this is not a nicety. A 1 s synchronous block
followed by one macrotask reads `active` +1000 ms against +20 ms idle. But
the same block read at a different moment in the process's life reported
**+0.2 ms** — because ELU's counters are refreshed by the loop, and a
reading taken at the wrong moment misses the interval entirely. Handing
back a cumulative number and hoping the caller spaces its reads is how that
goes wrong; the interval has to be explicit.

```js
let mark = monitor.utilization();
setInterval(() => {
  const window = monitor.utilizationSince(mark);
  mark = monitor.utilization();
  if (window && window.active > 100) console.warn('blocked', window.active);
}, 1000);
```

#### Parameters

##### previous

\{ `active`: `number`; `idle`: `number`; `utilization`: `number`; \} \| `null`

A reading from an earlier [PowerEventLoopMonitor#utilization](#utilization) call.

#### Returns

\{ `active`: `number`; `elapsed`: `number`; `idle`: `number`; `ratio`: `number`; `utilization`: `number`; \} \| `null`

`null` when ELU is unavailable or `previous` is `null`, so a caller can
  distinguish "no data" from "zero utilisation". `elapsed` is the interval
  in ms — `active + idle` — and `ratio` is `active / elapsed`, which is
  `0` rather than `NaN` for an empty interval.
