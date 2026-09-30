[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerEventLoopMonitor](../README.md) / PowerEventLoopMonitor

# Class: PowerEventLoopMonitor

Measure how long the event loop is unavailable.

Latency has a floor, and nothing in this library can tell you why latency
rose. A `PowerHistogram` of your own operation timings shows _that_ it rose;
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

---

### \_delay

> **\_delay**: [`PowerHistogram`](../../powerHistogram/classes/PowerHistogram.md)

---

### \_handle

> **\_handle**: `any`

---

### \_keepProcessAlive

> **\_keepProcessAlive**: `boolean`

---

### \_lastDelay

> **\_lastDelay**: `number`

---

### \_max

> **\_max**: `number`

---

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

---

### \_onDrift

> **\_onDrift**: ((`arg0`) => `void`) \| `null`

---

### \_running

> **\_running**: `boolean`

---

### \_samples

> **\_samples**: `number`

---

### \_sum

> **\_sum**: `number`

---

### \_utilizationSource

> **\_utilizationSource**: (() => `any`) \| `null`

---

### intervalMs

> **intervalMs**: `number`

---

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

---

### clear()

> **clear**(): `void`

Alias for [PowerEventLoopMonitor#reset](#reset).

`reset()` here _is_ a clear — it discards every accumulated sample, so both
words describe the same act. Contrast the limiters, where `reset()` restores
a usable state and `clear()` would read as the opposite.

#### Returns

`void`

---

### dispose()

> **dispose**(): `void`

Stop sampling and release the timer. Safe to call more than once.

This is the only thing that unregisters the metrics receipt, and it is
terminal: after it, `getStats()` still answers but the monitor reports
nothing, because the collector no longer calls it.

#### Returns

`void`

---

### histogram()

> **histogram**(): [`PowerHistogram`](../../powerHistogram/classes/PowerHistogram.md)

The drift histogram. Owned by the monitor; do not call `reset()` on it
directly, use [PowerEventLoopMonitor#reset](#reset) so the counters agree.

#### Returns

[`PowerHistogram`](../../powerHistogram/classes/PowerHistogram.md)

---

### lastDelay()

> **lastDelay**(): `number`

The last recorded drift, in milliseconds. `0` before the first sample.

#### Returns

`number`

---

### reset()

> **reset**(): `void`

Clear all recorded samples, as if the monitor were brand new. Does not stop
sampling.

#### Returns

`void`

---

### start()

> **start**(): `PowerEventLoopMonitor`

Begin sampling. Idempotent: a second call while running is a no-op.

#### Returns

`PowerEventLoopMonitor`

---

### stats()

> **stats**(): `object`

Serializable snapshot of the configuration and the recorded samples.

`mean`, `p50`, `p99` and `p99_9` are `null` before the first sample rather
than `0`, so a consumer cannot mistake "not measured yet" for "no delay".
They are _estimates_ - `PowerHistogram` is a DDSketch with a
`relativeAccuracy` bound - not exact quantiles.

#### Returns

`object`

##### active

> **active**: `boolean`

##### blockedOver10ms

> **blockedOver10ms**: `number`

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

---

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

---

### utilization()

> **utilization**(): \{ `active`: `number`; `idle`: `number`; `utilization`: `number`; \} \| `null`

Node's `eventLoopUtilization()` reading, or `null` where the runtime does
not provide it.

`null` is a real answer, not a zero: outside Node there is no such
measurement, and reporting `0` would read as a perfectly idle loop. Await
[PowerEventLoopMonitor#ready](#ready) first, or pass a `utilizationProvider`.

#### Returns

\{ `active`: `number`; `idle`: `number`; `utilization`: `number`; \} \| `null`
