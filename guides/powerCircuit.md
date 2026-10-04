# PowerCircuit

Simple circuit breaker primitive to protect external services from cascading failures.

## Constructor

`new PowerCircuit(options?)`

## Options

| Option       |          Type |        Default | Description                                                                                                                                                                                           |
| ------------ | ------------: | -------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `threshold`  |      `number` |            `5` | Consecutive failure threshold to open the circuit.                                                                                                                                                    |
| `timeout`    | `number` (ms) |        `30000` | **Base** milliseconds to keep the circuit open before allowing a trial (`half-open`) call. Consecutive trips grow this exponentially and jitter the result — see [The open window](#the-open-window). |
| `maxTimeout` | `number` (ms) | `timeout * 16` | Ceiling for the grown open window.                                                                                                                                                                    |

### Options are validated, not coerced

`threshold`, `timeout` and `maxTimeout` are validated. Before 2.0 they were read
as `Number(x) || default`, which treats `0` as absent — so `threshold: 0`
produced a breaker that **never trips**, and `timeout: 0` a 30 s open window. Both
now throw a `TypeError` naming the option.

`maxTimeout` is derived from `timeout` only when it is omitted, so an explicit
`maxTimeout: 0` throws rather than silently collapsing the open window to nothing.

## API

- `call(fn)` — Execute the provided function `fn` under circuit protection. Returns a `Promise` resolved with `fn`'s result or rejected if `fn` throws. When the circuit is open `call` will reject immediately with a circuit-open error.

- `state` (getter) — One of `'closed' | 'open' | 'half-open'`, indicating the current circuit state.

- `failures` (getter) — Number of consecutive failures that have been observed; this counter resets when a call succeeds.

- `lastError` — The last error observed from a failed protected call (useful for diagnostics and logging).

- `reset()` — Force the circuit into the `closed` state and clear internal counters/history, **including the backoff**, so the next trip starts from the base `timeout` again.

### The open window

`timeout` is the _base_, not the only window. A circuit that trips once opens for `timeout` (jittered); consecutive trips without an intervening success double it — `2x`, `4x`, … — up to `maxTimeout`. A successful trial resets the counter, so the next outage starts from the base again.

The jitter matters as much as the growth. With a fixed window, every circuit guarding the same dependency opened on the same tick and retried on the same tick, so the first request after the timeout arrived as an N-wide burst that re-tripped every breaker before the dependency had recovered — a self-inflicted thundering herd, and precisely the failure the breaker exists to prevent. The window is drawn **once**, when the circuit opens, and held for the duration of that open period: it is read by every `call()` and every `state` read, so a per-call draw would fluctuate the window and make the breaker flap rather than hold.

The draw is **equal jitter** — uniformly from `[delay / 2, delay]` — rather than AWS-style full jitter (`[0, delay]`). Full jitter is the right tool for a retry delay, where the aim is to spread attempts. A breaker's aim is the opposite: to keep traffic away. A full-jitter draw of a 30 s backoff can land near zero, which re-opens the circuit almost immediately and leaves you with a breaker that flaps instead of holding. Half-jitter still randomises — which is what breaks the lockstep — while guaranteeing the window never falls below half the computed backoff.

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

## Clocks

The open window is measured with **`monoMs()`**, the monotonic clock, not
`nowMs()`. The breaker subtracts two readings and never needs to know what time
it is, so there is no reason for it to be movable — and before 2.0 it
was.

The defect, measured with **zero** real milliseconds elapsed and only the wall
clock moved: a breaker opened with `timeout: 60000` reported `half-open`
immediately after the system clock stepped forward 60 s. A dependency that had
been failing for a millisecond was offered a trial call, and a trial that fails
re-opens the window — so a clock step could hold a dependency in
`half-open` indefinitely, hammering it once per window.

A step **backwards** was always harmless here: `nowMs() - _openedAt <
_openWindowMs` keeps reading an earlier instant as "not much time has passed". It
is the forward step that hands out a trial nobody waited for.

**This class has no `now` option.** The three rate limiters do, and it is the
supported way to drive their clock; here the window is measured from the real
monotonic clock, so a test that needs to reach `half-open` waits out the drawn
window (`circuit._openWindowMs`) rather than moving a clock. Set a small
`timeout` instead of reaching into the clock.

See [`now.md`](now.md) for the two clocks and when each is the right one.

## Observability example

You can subscribe to the `PowerEventBus` to centralize state-change handling across multiple circuits or components:

```javascript
bus.on('stateChange', ({ state, reason }) => {
  // record metrics, raise alerts, or update UI
  console.info('circuit-change', state, reason);
});
```
