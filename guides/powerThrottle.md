# PowerThrottle

A small token-bucket rate limiter useful for pacing work (API calls, renders, or cooperating with `PowerPool`).

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `capacity` | `number` | `1` | Maximum tokens the bucket can hold.
| `tokens` | `number` | `capacity` | Initial token count (clamped to `capacity`).
| `refillRate` | `number` | `0` | Tokens added per second (fractional accumulation supported).
| `refillInterval` | `number` | `1000` | Internal bookkeeping interval (ms) used for refill math.

## API

- `tryConsume(n = 1)` — Attempt to consume `n` tokens (default `1`). Returns `true` when tokens were available and consumed; otherwise returns `false`.

- `available()` — Return the current number of available tokens (performs a refill calculation before reporting).

- `addTokens(n)` — Forcefully add up to `n` tokens to the bucket (clamped to `capacity`). Handy for tests or to manually replenish tokens.

- `reset(count?)` — Reset the token count to `count`. When omitted the bucket is refilled to full `capacity`.

## Example

```javascript
import { PowerThrottle } from '../src/helpers/powerThrottle.js';
import { PowerPool } from '../src/index.js';

// Real-world example: pace API calls and buffer pending work with gentle backoff.
const limiter = new PowerThrottle({ capacity: 5, refillRate: 1 }); // burst 5, 1 token/sec
const pool = new PowerPool(MyWorker, { size: 2 });
const pending = [];

function scheduleRequest(payload) {
  if (limiter.tryConsume()) {
    pool.postMessage({ task: 'call', payload });
    return;
  }
  // push into pending buffer with retry metadata
  pending.push({ payload, attempts: 0, nextDelay: 200 });
}

// Periodically drain pending with small backoff per-item to avoid bursts
const drainInterval = setInterval(() => {
  for (let i = 0; i < pending.length; ) {
    const item = pending[i];
    if (!limiter.tryConsume()) break;
    // dispatch
    pool.postMessage({ task: 'call', payload: item.payload });
    pending.splice(i, 1);
  }
  // if queue still contains items, apply exponential backoff to retry scheduling later
  for (const it of pending) {
    it.attempts += 1;
    it.nextDelay = Math.min(30_000, Math.round(it.nextDelay * 1.5));
  }
  if (!pending.length) clearInterval(drainInterval);
}, 250);
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
