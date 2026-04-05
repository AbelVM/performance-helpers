# PowerEventBus

Typed micro event bus for intra-process pub/sub. Useful for wiring multiple helpers (pools, queues, observers) together without coupling.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `maxListeners` | `number` | `0` | Maximum listeners per event; `0` means unlimited. |
| `weak` | `boolean` | `false` | When `true` listeners are stored as `WeakRef` (when supported) and automatically cleaned by GC. |

## API

- `on(evt, fn)` — Subscribe to events named `evt`. `fn(payload)` will be called for each emit. Returns an unsubscribe function. Listener errors are swallowed.

- `once(evt, fn)` — Subscribe for a single invocation; the listener is removed automatically after the first emit.

- `off(evt, fn)` — Remove a previously-registered listener for `evt`.

- `emit(evt, payload)` — Emit an event with an optional `payload`; returns `true` if at least one listener was invoked. Errors thrown by listeners are swallowed to avoid propagation.

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
// unsub();
```

## Notes

- Errors thrown by listeners are swallowed to avoid breaking the emitter.
- `listeners(evt)` returns a shallow copy of the listener list and may be used for debugging or metrics.
