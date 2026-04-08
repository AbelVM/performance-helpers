# PowerObserver

Lightweight reactive value container. Useful for exposing small pieces of state (metrics, counters, flags) without pulling in a full reactivity library.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `map` | `function` | `undefined` | Optional mapping function applied to values before notifying subscribers. Receives the raw value and returns the mapped value passed to subscribers. |
| `distinct` | `boolean` | `false` | When `true`, notifications are suppressed when the mapped value is equal to the previous mapped value (uses `Object.is`). |
| `async` | `boolean|'microtask'|'macrotask'` | `'microtask'` | Scheduling strategy for notifications: `'microtask'` (default), `'macrotask'` (uses `setTimeout(...,0)`), or `false`/`sync` for immediate delivery. |

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
