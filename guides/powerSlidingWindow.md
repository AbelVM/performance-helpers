# PowerSlidingWindow

A sliding-window rate limiter that allows up to `capacity` events per `windowMs`.

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `capacity` | `number` | `1` | Maximum allowed events in a window.
| `windowMs` | `number` | `1000` | Window size in milliseconds.

## API

- `tryConsume(n = 1)` — Attempt to consume `n` slots (default `1`) in the current rolling window. Returns `true` when the requested slots are available and the call consumes them; otherwise returns `false`.

- `available()` — Return the current number of available slots in the window. This performs a prune of stale timestamps before reporting.

- `reset()` — Clear internal state and timestamp queue, effectively refilling the window.

## Example

```javascript
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerPool } from '../src/index.js';

const limiter = new PowerSlidingWindow({ capacity: 5, windowMs: 1000 });
if (limiter.tryConsume()) {
  // allowed
} else {
  // rate limited
}
```

### Example: cooperating with `PowerPool`

Use a `PowerSlidingWindow` to cap how many tasks you dispatch into a `PowerPool` within a rolling window. This example enqueues tasks and keeps a `pending` list for items that must wait until quota becomes available.

```javascript
const limiter = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });
const pool = new PowerPool(MyWorker, { size: 2 });

const pending = [];
function scheduleTask(payload) {
  if (limiter.tryConsume()) {
    pool.postMessage({ task: 'do', payload });
  } else {
    pending.push(payload);
  }
}

for (let i = 0; i < 10; i++) scheduleTask({ i });

// Periodically attempt to drain pending tasks when the window slides.
const interval = setInterval(() => {
  while (pending.length && limiter.tryConsume()) {
    pool.postMessage({ task: 'do', payload: pending.shift() });
  }
  if (!pending.length) clearInterval(interval);
}, 200);

await pool.drain();
pool.terminate();
```
