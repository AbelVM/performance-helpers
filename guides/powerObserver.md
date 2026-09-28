# PowerObserver

Lightweight reactive value container. Useful for exposing small pieces of state (metrics, counters, flags) without pulling in a full reactivity library.

## Constructor

| Option     |       Type |     Default | Description                                                                                                                                          |
| ---------- | ---------: | ----------: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map`      | `function` | `undefined` | Optional mapping function applied to values before notifying subscribers. Receives the raw value and returns the mapped value passed to subscribers. |
| `distinct` |  `boolean` |     `false` | When `true`, notifications are suppressed when the mapped value is equal to the previous mapped value (uses `Object.is`).                            |
| `async`    |   `boolean | 'microtask' | 'macrotask'`                                                                                                                                         | `'microtask'` | Scheduling strategy for notifications: `'microtask'` (default), `'macrotask'` (uses `setTimeout(...,0)`), or `false`/`sync` for immediate delivery. |

## API

- `subscribe(fn)` — Subscribe to mapped value changes. `fn(next, prev)` is invoked with the mapped current and previous values. Returns an unsubscribe function. Subscriber errors are swallowed to avoid breaking the publisher.

- `clear()` — Remove all subscribers.

- `map(fn)` — Set or clear the optional mapping function applied to values before notifying subscribers. Pass `null` to remove the mapping.

- `flush()` / `drain()` — Force immediate delivery of any pending async notification; useful in tests or during shutdown to ensure all scheduled notifications are processed synchronously.

- `size` (getter) — Number of current subscribers.

- `value` (getter/setter) — Read or update the current raw value. Setting `value` schedules or delivers notifications according to the `async` option and mapped output.

## Example

```javascript
import { PowerObserver } from '../src/helpers/powerObserver.js';

// Example — live concurrent-requests gauge for a metrics exporter

// Expose a small reactive gauge that tracks concurrent HTTP requests
const concurrentRequests = new PowerObserver(0, { async: 'microtask', distinct: true });

// Subscribe a metrics reporter that pushes a sample when the value changes
concurrentRequests.subscribe((next, prev) => {
  // `pushMetric` is an app-defined helper that exports to Prometheus / StatsD
  pushMetric('http.concurrent_requests', next);
  // also log occasionally
  if (next === 0 && prev > 0) console.info('all requests completed');
});

// Instrument a simple request handler
async function handleRequest(req) {
  concurrentRequests.value = concurrentRequests.value + 1;
  try {
    // process request
    await doWork(req);
  } finally {
    concurrentRequests.value = concurrentRequests.value - 1;
  }
}

// For tests or graceful shutdown you can flush pending async notifications
await Promise.resolve(); // ensure microtask queue drained
concurrentRequests.flush();
```

## Notes

- Subscriber errors are swallowed to avoid breaking the publisher.
- `subscribe` returns an unsubscribe function.
- `flush()` is useful in tests or during shutdown to ensure all pending notifications are delivered synchronously.

## Derived observers

`map()` _mutates_ this observer's mapping and returns nothing. For building chains
without disturbing the source, there are four derived forms that return a **new**
`PowerObserver`:

| Method                                 | Emits                                       | Value of the derived           |
| -------------------------------------- | ------------------------------------------- | ------------------------------ |
| `derive(fn)`                           | on every upstream change                    | `fn(next, prev)`               |
| `filter(predicate)`                    | only when `predicate(next, prev)` is true   | the last value that **passed** |
| `distinct()`                           | only when the value changes, by `Object.is` | the latest value               |
| `PowerObserver.combineLatest(a, b, …)` | when **any** source changes                 | `[a.value, b.value, …]`        |

```js
const label = user.derive((u) => u.name).filter((name) => name.length > 0);

const off = label.subscribe((name) => render(name));
```

### Two things worth knowing before you rely on them

**The upstream is subscribed lazily, and released eagerly.** A derived observer
subscribes to its source on _first subscribe_ and releases it on _last
unsubscribe_. That is the whole difficulty with derived observables: a chain of
ten `derive` calls held by one consumer would otherwise keep all ten upstreams
alive, and a consumer that unsubscribes and is then collected would leave every
one of them running. Nothing is subscribed until someone asks, and everything is
released when they stop.

**So while nobody is subscribed, the derived value is a snapshot, not a live
value** — what it captured when the chain was built:

```js
const d = source.derive((v) => v * 2);
source.value = 5;
d.value; // 0 — the snapshot, because nothing is subscribed yet
const off = d.subscribe(() => {}); // attaching is what makes it current
source.value = 6;
d.value; // 12
```

That is the direct cost of not subscribing, and it is the same trade that makes an
unused chain free. A consumer that needs a live value has to subscribe, which is
precisely what makes the subscription happen.

### `distinct()` and the `distinct` option are different

`distinct()` is per-derived-observer and changes nothing about the source. The
`distinct` constructor option suppresses _this_ observer's own notifications.
Use the option when the observer should never re-notify for an unchanged value;
use the method when you want a derived that does the same without touching the
source.

### Scheduling is inherited

A derived observer inherits its source's `async` mode, so `derive` on a
synchronous observer delivers synchronously. The encoding is subtle and worth
knowing if you construct derived observers by hand: the internal mode is the string
`'sync'`, but the `async` **option** spells sync as `false` and rejects the string
`'sync'` — it falls through to the default and you silently get a microtask.
