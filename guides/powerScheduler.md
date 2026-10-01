# PowerScheduler

A tiny scheduler helper for coalescing deferred work into a single microtask or macrotask.

Use `PowerScheduler` when you need a shared `schedule()`, `flush()`, and `cancel()` abstraction for batching updates, notifications, or buffered work.

## Constructor

| option       |                                    type | default       | description                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | --------------------------------------: | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduling` | `'microtask' \| 'macrotask' \| 'yield'` | `'microtask'` | Scheduling mode used to defer the flush callback. `microtask` uses `queueMicrotask`; `macrotask` posts to a `MessageChannel`; `yield` uses `scheduler.yield()` where it exists and falls back to a macrotask where it does not. An unrecognised value **throws** — it used to be `=== 'macrotask' ? 'macrotask' : 'microtask'`, so a typo silently selected the _fastest_ strategy. |

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

## `yield` scheduling, and why there is no `idle` mode

`scheduling: 'yield'` uses **`scheduler.yield()`**, the browser-native way to
hand control back to the event loop. It is prioritised ahead of the rendering
and task queues, which is what makes it the right primitive for a scheduler
whose job is to run _promptly_ — a flush that yields gets the same priority a
microtask would, without the microtask's "never yields to input" property.

The feature is detected **once at module load**, not per flush: it is a stable
property of the runtime, and probing it on every flush would add a property read
to the hot path to learn something that cannot change.

Where it does not exist (Node, and Firefox until recently) the strategy falls
back to a macrotask. That is a degradation in **ordering**, not correctness — the
flush still happens promptly — and it is visible rather than silent:

```javascript
const s = new PowerScheduler(flush, { scheduling: 'yield' });
s.strategy; // { scheduling: 'yield', supported: false }
```

`strategy` reports what was _requested_ and whether the runtime can honour it.
Reporting only the request would make the substitution invisible, which is the
thing worth avoiding.

### Why not `requestIdleCallback`

`requestIdleCallback` was considered for this row and **refused**, for a reason
that is about the contract rather than the implementation: a scheduler's whole
promise is that a scheduled flush _happens_, promptly, and `drain()`/`flush()`
are meaningless if the callback may never run at all. Idle callbacks are for
"do this when there is slack" — genuinely useful, and a different primitive with
a different contract.

If you want idle work, drive it from something that does not promise latency —
a chunked cleanup loop that yields between batches, rather than a scheduler
flush.

### Cancellation is logical, not structural

A `scheduler.yield()` continuation is already queued the moment it is requested
and returns only a promise: **there is no handle to detach**. So `flush()` and
`cancel()` cannot un-schedule it. They do not need to — `_run()` opens with
`if (!this._scheduled) return`, and both clear `_scheduled` first, so an
abandoned continuation arrives, finds the schedule closed, and does nothing.

That is worth stating because the obvious implementation is a generation
counter, and one was written. Removing it entirely left all seven yield-path
tests green: an **equivalent mutant**, caught by mutation testing rather than by
reading. It was deleted rather than kept as belt-and-braces, because machinery
that no test can distinguish from its absence is machinery nobody will maintain.

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

### Sharing that module-level channel has a cost, and it is handled

`dispose()` releases the channel, because a started `MessagePort` keeps a Node
process alive and `unref()` alone is not enough once the ports are open. But the
channel is **module-level**, so "release it" means "release it for every
scheduler in the process". Closing it while another scheduler had a flush in
flight discarded that flush, left its `scheduled` flag stuck at `true`, and made
every later `schedule()` a silent no-op — a scheduler that never ran again for the
life of the object. Only `cancel()` recovered it.

So the channel is tracked: posts in flight are counted, and `dispose()` **drops
the module reference but only closes the ports when nothing is pending**. The next
scheduler to schedule builds a fresh pair; the pending post is still delivered on
the old, already-`unref()`ed one, so nothing holds the process open. Disposing
during your own idle path closes the ports as before.

The practical rule: **a `dispose()` on one macrotask scheduler is not a
process-wide event any more**, so it is safe inside `using` blocks with other
schedulers alive — which it was not.

If you need a _deadline_ rather than a macrotask, reach for
[PowerDeadline](powerDeadline.md). And if you want a recurring schedule rather
than a per-turn flush, see [PowerCron](powerCron.md).
