# PowerSlidingWindow

A sliding-window rate limiter that allows up to `capacity` events per `windowMs`.

## Constructor

`new PowerSlidingWindow(options)`

| option | type | default | description |
|---|---:|---:|---|
| `capacity` | `number` | `1` | Maximum allowed events in a window.
| `windowMs` | `number` | `1000` | Window size in milliseconds.

## Methods

| method | params | returns | description |
|---|---|---|---|
| `tryConsume(n = 1)` | `n: number` | `boolean` | Attempt to consume `n` slots in the current window. Returns `true` when within quota.
| `available()` | — | `number` | Number of remaining slots in the current window.
| `reset()` | — | `void` | Clear internal state.

## Example

```javascript
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';

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
