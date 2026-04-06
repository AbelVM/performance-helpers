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

- `reserve(n = 1)` — Reserve `n` tokens without committing them permanently. Returns a token object when successful (useful to later `release()` or `rollback()`), or `null` when reservation fails.

- `release(tokenOrN)` — Release a prior reservation token or numeric token count back into the bucket. Accepts either a token returned from `reserve()` or a numeric value.

- `rollback(nOrToken)` — Alias for `release()` for compatibility with undo patterns.

## Example

```javascript
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

const limiter = new PowerThrottle({ capacity: 5, refillRate: 1 }); // burst 5, 1 token/sec
const pending = [];

async function sendEvent(payload) {
  if (!limiter.tryConsume()) {
    pending.push(payload);
    return;
  }

  try {
    await fetch('https://api.example.com/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error('send failed', error);
    pending.push(payload);
  }
}

const drainInterval = setInterval(async () => {
  while (pending.length && limiter.tryConsume()) {
    const payload = pending.shift();
    await sendEvent(payload);
  }
  if (!pending.length) {
    clearInterval(drainInterval);
  }
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

### Reservation example

You can reserve tokens when you need to prepare work that should only consume a token once the work is actually dispatched. This is useful when coordinating with composed limiters that expect an atomic reservation step.

```javascript
const limiter = new PowerThrottle({ capacity: 2, tokens: 2, refillRate: 0 });
const token = limiter.reserve(1);
if (token) {
  // do preparation work (serialize payload, open resources)
  // when ready to dispatch:
  // if something goes wrong before dispatch, release the reservation
  limiter.release(token);
}
```
