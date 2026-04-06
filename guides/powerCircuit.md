# PowerCircuit

Simple circuit breaker primitive to protect external services from cascading failures.

## Constructor

`new PowerCircuit(options?)`

## Options

| Option | Type | Default | Description |
|---|---:|---:|---|
| `threshold` | `number` | `5` | Consecutive failure threshold to open the circuit. |
| `timeout` | `number` (ms) | `30000` | Milliseconds to keep the circuit open before allowing a trial (`half-open`) call. |

## API

- `call(fn)` — Execute the provided function `fn` under circuit protection. Returns a `Promise` resolved with `fn`'s result or rejected if `fn` throws. When the circuit is open `call` will reject immediately with a circuit-open error.

- `state` (getter) — One of `'closed' | 'open' | 'half-open'`, indicating the current circuit state.

- `failures` (getter) — Number of consecutive failures that have been observed; this counter resets when a call succeeds.

- `lastError` — The last error observed from a failed protected call (useful for diagnostics and logging).

- `reset()` — Force the circuit into the `closed` state and clear internal counters/history.

- `onStateChange` (constructor option) — Optional callback `(state, reason?)` invoked whenever the circuit transitions between states. The callback is called with the new state (`'closed'|'open'|'half-open'`) and an optional reason string such as `'thresholdExceeded'`, `'trialFailed'`, `'timeoutElapsed'`, `'success'`, or `'reset'`. User callback errors are swallowed by the circuit to avoid interfering with control flow.

- `eventBus` (constructor option) — Optional instance of `PowerEventBus` to receive `stateChange` events. When provided the circuit will emit `{ state, reason }` objects on the bus under the `'stateChange'` event name.

## Example

```javascript
import { PowerCircuit } from '../src/helpers/powerCircuit.js';

// Real-world example: protect an HTTP fetch to a flaky external API.
// Provide observability hooks: callback and an optional event bus.
import { PowerEventBus } from '../src/helpers/powerEventBus.js';
const bus = new PowerEventBus();

const cb = new PowerCircuit({
  threshold: 3,
  timeout: 5_000,
  onStateChange: (state, reason) => console.log('circuit state ->', state, reason),
  eventBus: bus,
});

async function fetchWithCircuit(url, opts) {
  return cb.call(async () => {
    const res = await fetch(url, opts);
    if (!res.ok) throw Object.assign(new Error('HTTP'), { status: res.status });
    return res.json();
  });
}

// Usage: this attempts the request; after 3 consecutive failures the circuit
// opens and subsequent calls will immediately reject with `{ code: 'ECIRCUITOPEN' }`.
async function doWork() {
  try {
    const data = await fetchWithCircuit('https://api.example.com/data');
    console.log('got', data);
  } catch (err) {
    if (err && err.code === 'ECIRCUITOPEN') {
      // fallback behavior while the circuit is open (serve cached data)
      console.warn('service unavailable — serving stale cache');
      return cache.get('latest') || { source: 'stale' };
    }
    console.error('request failed', err);
    throw err;
  }
}
```

## Observability example

You can subscribe to the `PowerEventBus` to centralize state-change handling across multiple circuits or components:

```javascript
bus.on('stateChange', ({ state, reason }) => {
  // record metrics, raise alerts, or update UI
  console.info('circuit-change', state, reason);
});
```
