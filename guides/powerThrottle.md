# PowerThrottle

A small token-bucket rate limiter useful for pacing work (API calls, renders, or cooperating with `PowerPool`).

## Constructor

`new PowerThrottle(options)`

| option | type | default | description |
|---|---:|---:|---|
| `capacity` | `number` | `1` | Maximum tokens the bucket can hold.
| `tokens` | `number` | `capacity` | Initial token count (clamped to `capacity`).
| `refillRate` | `number` | `0` | Tokens added per second (fractional accumulation supported).
| `refillInterval` | `number` | `1000` | Internal bookkeeping interval (ms) used for refill math.

## Methods

| method | params | returns | description |
|---|---|---|---|
| `tryConsume(n = 1)` | `n: number` | `boolean` | Attempt to consume `n` tokens. Returns `true` if tokens were available and consumed, `false` otherwise.
| `available()` | — | `number` | Returns current available tokens (performs a refill before returning).
| `addTokens(n)` | `n: number` | `void` | Force-add up to `n` tokens (clamped to `capacity`). Useful for tests or manual replenishment.
| `reset(count?)` | `count?: number` | `void` | Reset the token count to `count` or full `capacity` when omitted.

## Example

```javascript
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

const limiter = new PowerThrottle({ capacity: 5, refillRate: 1 });
if (limiter.tryConsume()) {
  // make request
} else {
  // backoff or retry later
}
```

### Example: cooperating with `PowerPool`

Use a `PowerThrottle` to pace messages enqueued to a `PowerPool` so the pool only processes at most N tasks per second. This is useful when downstream rate limits or external APIs require pacing.

```javascript
// limiter: 3 tokens/sec, burst capacity 3
const limiter = new PowerThrottle({ capacity: 3, refillRate: 3 });
const pool = new PowerPool(MyWorker, { size: 2 });
const pending = [];

function scheduleTask(payload) {
  // tryConsume returns true when a token is available
  if (!limiter.tryConsume()) {
    // requeue for later processing
    pending.push(payload);
    return;
  }
  // dispatch to the pool; optionally target a worker
  pool.postMessage({ task: 'do', payload });
}

// enqueue tasks from some source
for (let i = 0; i < 10; i++) scheduleTask({ i });

// Periodically attempt to drain pending tasks when tokens become available.
const drainInterval = setInterval(() => {
  while (pending.length && limiter.tryConsume()) {
    const p = pending.shift();
    pool.postMessage({ task: 'do', payload: p });
  }
  // stop when no pending tasks
  if (!pending.length) clearInterval(drainInterval);
}, 200);

// drain when done
await pool.drain();
pool.terminate();
```
