# PowerEventBus

Typed micro event bus for intra-process pub/sub. Useful for wiring multiple helpers (pools, queues, observers) together without coupling.

## Constructor

| Option         |      Type | Default | Description                                                                                     |
| -------------- | --------: | ------: | ----------------------------------------------------------------------------------------------- |
| `maxListeners` |  `number` |     `0` | Maximum listeners per event; `0` means unlimited.                                               |
| `weak`         | `boolean` | `false` | When `true` listeners are stored as `WeakRef` (when supported) and automatically cleaned by GC. |

## Type-safe event names

`PowerEventBus` accepts an optional generic type parameter that maps event
names to their payload shapes. When provided, `on`, `emit`, and the other
public methods only accept event names that exist on the type, so a typo such
as `bus.emit('stateChagne', ...)` is caught at compile time instead of
silently dropping the event.

```typescript
interface AppEvents {
  stateChange: { state: string };
  userLogin: { userId: string };
}

const bus = new PowerEventBus<AppEvents>();

bus.on('stateChange', ({ state }) => {
  /* ... */
});
bus.emit('stateChange', { state: 'active' });
bus.emit('stateChagne', { state: 'active' }); // Type error: 'stateChagne' is not a key of AppEvents
```

Without a type argument the bus falls back to the untyped form and accepts any
string event name, which is the existing runtime behaviour.

## API

- `on(evt, fn)` — Subscribe to events named `evt`. `fn(payload)` will be called for each emit. Returns an unsubscribe function. Listener errors are swallowed — including a rejection from a listener that returned a promise (see [async listeners](#async-listeners-are-observed-too)).

- `once(evt, fn)` — Subscribe for a single invocation; the listener is removed automatically after the first emit.

- `off(evt, fn)` — Remove a previously-registered listener for `evt`.

- `emit(evt, payload)` — Emit an event with an optional `payload`; returns `true` if at least one listener was invoked. Both a synchronous throw and an asynchronous rejection from a listener are swallowed, so a failing subscriber cannot break the emitter or reach the process.

- `emitAsync(evt, payload, { concurrency = Infinity })` — Emit an event and await async listeners. The optional `concurrency` parameter limits how many listeners run in parallel, making listener pipelines easier to manage.

- `listeners(evt)` — Return a shallow copy array of listeners for debugging or metrics.

- `clear(evt?)` — Remove listeners for a specific `evt`, or all listeners when `evt` is omitted.

## Example

```javascript
import { PowerEventBus } from '../src/helpers/powerEventBus.js';
import { PowerPool } from '../src/helpers/powerPool.js';

// Use PowerEventBus to coordinate cross-cutting concerns (metrics, shutdown)
const bus = new PowerEventBus();
const pool = new PowerPool('./worker.js', { size: 2 });

// Publish a lightweight event whenever a worker finishes a job
pool.addEventListener('message', (e) => {
  const d = e && e.data;
  if (d && d.type === 'job:done') bus.emit('job:done', d.payload);
});

// Subscribe from elsewhere in the app without coupling to `pool`
const unsub = bus.on('job:done', ({ id, result }) => {
  metrics.increment('jobs.completed');
  cache.set(id, result);
});

// Graceful shutdown: listen once for pool drain then stop services
bus.once('idle', async () => {
  console.log('pool is idle — shutting down');
  await closeDatabaseConnections();
});

// Emit 'idle' when appropriate (could be wired from `pool.drain()`)
(async () => {
  await pool.drain();
  bus.emit('idle');
})();

// later
// (call the returned unsubscribe function when appropriate)
```

## Notes

- Both a synchronous throw and a rejection from a listener that returned a
  promise are swallowed, so a failing subscriber cannot break the emitter.

### Async listeners are observed too

`emit` is synchronous and fire-and-forget, and it **observes the promise a
listener returns** rather than ignoring it. This is not belt-and-braces: an
unobserved promise rejection reaches the process, and **Node's default
`--unhandled-rejections=throw` since v15 terminates it.** Before this, an `async`
listener that threw killed the host from inside a notification nobody was
awaiting:

```js
const bus = new PowerEventBus();
bus.on('ready', async () => {
  throw new Error('boom');
});
bus.emit('ready'); // the process used to die here
```

A listener that rejects is **not** unsubscribed — a listener that throws is not
the same as a listener that removed itself, and dropping it would turn one bad
event into a permanently missing one. If you want a failing listener to be
reported rather than swallowed, use `emitAsync`, which surfaces it to its caller.

This also covers `once`, and reaching it needed a second fix:
`PowerSubscriberSet`'s once-wrapper discarded the listener's return value, so the
promise died inside the wrapper before `emit` could see it. A hand-rolled
thenable — anything with a callable `.then` — is handled the same way, since
`instanceof Promise` would miss a deferred or a cross-realm `PromiseLike`.

- `listeners(evt)` returns a shallow copy of the listener list and may be used for debugging or metrics.

### This bus is intra-process, and that is the fast part

`PowerEventBus` coordinates **within one process**. Measured on this build:

| operation                       | ns/op (min / median / max) |
| ------------------------------- | -------------------------: |
| `emit`, 1 listener              |          34 / **49** / 136 |
| `emit`, 10 listeners            |          56 / **61** / 124 |
| `emit`, 100 listeners           |        453 / **482** / 618 |
| in-process relay (bus → bus)    |         80 / **107** / 284 |
| a full `BroadcastChannel` relay |       706 / **856** / 1025 |

About 4.8 ns per subscriber, one synchronous call, no copies and no serialization
— a bus was never doing the thing a broadcast channel is good at, which is
replacing _N posts with 1_. The relay row is the honest comparison: bridging
across a `BroadcastChannel` costs **1.5× the entire 100-listener emit it would be
replacing**.

Two further costs if you bridge anyway:

- **The obvious bridge is an infinite loop.** `BroadcastChannel` excludes only
  the _posting_ context, not a relay _listener_, so A posts → B's relay fires → B
  posts → A's relay fires, forever. One injected message produced **89 142 posts
  in 300 ms** with two contexts. Damping it needs a per-message origin id and a
  seen-set — a protocol, not an adapter.
- **`maxListeners` never fires for a remote listener.** The cap is checked when a
  listener is _added_; a remote one is synthesised inside `emit`. 10 remote emits
  against a `maxListeners: 2` bus produced **zero warnings**, so the leak the cap
  exists to surface is invisible across a boundary.

**Recommendation: do not cross context boundaries with this class.** If you need
cross-tab eventing, an origin-tagged protocol in the application that needs it
can answer the membership and loop questions from its own requirements; and for
cross-_context_ fan-out with bounded queues,
[PowerRealtimeHub](powerRealtimeHub.md) is the class whose guarantees are about
that. See [troubleshooting](troubleshooting.md#a-broadcastchannel-hangs-the-process-or-a-slow-receiver-eats-all-your-memory)
for the two platform properties that make this counter-intuitive.

## Real-world: async listeners with bounded concurrency

```javascript
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

const bus = new PowerEventBus();

// register several async listeners that perform IO
bus.on('user:signup', async (user) => {
  await sendWelcomeEmail(user.email);
});
bus.on('user:signup', async (user) => {
  await indexUserInSearch(user);
});

// When emitting, await listeners but limit concurrency to avoid resource spikes
await bus.emitAsync('user:signup', { id: 'u1', email: 'a@b.com' }, { concurrency: 2 });
```

Use `emitAsync` when you need to await listeners (for ordering, crash-safety, or to limit concurrency). The regular `emit` remains cheaper when you only need fire-and-forget behavior.
