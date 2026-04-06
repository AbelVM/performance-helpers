# PowerScheduler

A tiny scheduler helper for coalescing deferred work into a single microtask or macrotask.

Use `PowerScheduler` when you need a shared `schedule()`, `flush()`, and `cancel()` abstraction for batching updates, notifications, or buffered work.

## Constructor

| option | type | default | description |
|---|---:|---|---|
| `scheduling` | `'microtask' \'|'macrotask'` | `'microtask'` | Scheduling mode used to defer the flush callback. `microtask` uses `queueMicrotask`, and `macrotask` uses `setTimeout(fn, 0)`. |

## API

- `schedule()` — Schedule the flush callback once. Subsequent calls before flush are no-ops.
- `flush()` — Immediately invoke the pending flush if one is scheduled.
- `cancel()` — Cancel a pending flush without invoking the callback.
- `scheduled` — `true` when a flush is pending.

## Example

```js
import { PowerScheduler } from '../src/helpers/powerScheduler.js';

const scheduler = new PowerScheduler(() => {
  console.log('flushed');
}, { scheduling: 'microtask' });

scheduler.schedule();
// multiple schedule() calls before the microtask runs are coalesced
scheduler.schedule();

await Promise.resolve();
// 'flushed' has been logged once
```

## Notes

- `PowerScheduler` is a small utility for helpers like `PowerBatch` and `PowerObserver` that need consistent delayed execution and a flush API.
- Use `flush()` in tests or shutdown paths to make deferred work deterministic.
- Use `cancel()` when queued work should be discarded instead of executed.
