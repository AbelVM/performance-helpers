# PowerScheduler

A tiny scheduler helper for coalescing deferred work into a single microtask or macrotask.

Use `PowerScheduler` when you need a shared `schedule()`, `flush()`, and `cancel()` abstraction for batching updates, notifications, or buffered work.

## Constructor

| option       |         type | default      | description   |
| ------------ | -----------: | ------------ | ------------- |
| `scheduling` | `'microtask' | 'macrotask'` | `'microtask'` | Scheduling mode used to defer the flush callback. `microtask` uses `queueMicrotask`, and `macrotask` uses `setTimeout(fn, 0)`. |

## API

- `schedule()` — Schedule the flush callback once. Subsequent calls before flush are no-ops.
- `flush()` — Immediately invoke the pending flush if one is scheduled.
- `cancel()` — Cancel a pending flush without invoking the callback.
- `scheduled` — `true` when a flush is pending.

## Example

```js
import { PowerScheduler } from '../src/helpers/powerScheduler.js';

const scheduler = new PowerScheduler(
  () => {
    console.log('flushed');
  },
  { scheduling: 'microtask' }
);

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

## Macrotask scheduling is not `setTimeout(0)`

Since 2.0, `scheduling: 'macrotask'` posts to a **`MessageChannel`** rather than
calling `setTimeout(fn, 0)`.

That matters more than it looks. Node clamps a zero timeout to **1 ms**, so the
obvious implementation pays a full millisecond on every single flush. Measured in
this runtime over 10 000 macrotasks:

| mechanism        | 10 000 macrotasks |
| ---------------- | ----------------: |
| `MessageChannel` |         **37 ms** |
| `setTimeout(0)`  |         10 554 ms |

A port message is a real macrotask with no clamping floor, and it is available in
Node and in every browser. `setImmediate` is used where `MessageChannel` is
missing, and `setTimeout(0)` only as a last resort.

The port is created **once** at module scope rather than per flush — a channel per
flush would allocate a pair of ports each time, which is the cost being avoided —
and the reference is kept so it cannot be collected out from under us. Each post
adds a listener that removes itself when it fires, which is what lets `flush()` and
`cancel()` detach a pending post instead of leaving it queued.

If you need a _deadline_ rather than a macrotask, reach for
[PowerDeadline](powerDeadline.md). And if you want a recurring schedule rather
than a per-turn flush, see [PowerCron](powerCron.md).
