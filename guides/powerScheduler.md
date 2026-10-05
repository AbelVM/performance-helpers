# PowerScheduler

A tiny scheduler helper for coalescing deferred work into a single microtask or macrotask.

Use `PowerScheduler` when you need a shared `schedule()`, `flush()`, and `cancel()` abstraction for batching updates, notifications, or buffered work.

## Constructor

| option         |                                                  type | default          | description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------: | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduling`   | `'microtask' \| 'macrotask' \| 'yield' \| 'postTask'` | `'microtask'`    | Scheduling mode used to defer the flush callback. `microtask` uses `queueMicrotask`; `macrotask` posts to a `MessageChannel`; `yield` uses `scheduler.yield()` where it exists; `postTask` uses `scheduler.postTask()` with a `TaskController`. `yield` and `postTask` fall back to a macrotask where they do not exist, and `strategy.supported` reports the substitution. An unrecognised value **throws** — it used to be `=== 'macrotask' ? 'macrotask' : 'microtask'`, so a typo silently selected the _fastest_ strategy. |
| `taskPriority` |   `'user-blocking' \| 'user-visible' \| 'background'` | `'user-visible'` | Priority handed to `scheduler.postTask`. Only used when `scheduling` is `'postTask'`. The value is validated on every strategy — following `PowerCache`'s `filter`, an unrecognised one throws there too rather than sitting there doing nothing — while a valid one on a strategy with no use for it is accepted and inert, so a caller forwarding a shared options object is not broken.                                                                                                                                      |
| `onError`      |                  `((error: unknown) => void) \| null` | `null`           | Called when a flush throws, synchronously or as an async rejection. A throwing `onError` is swallowed.                                                                                                                                                                                                                                                                                                                                                                                                                          |

## API

- `schedule()` — Schedule the flush callback once. Subsequent calls before flush are no-ops.
- `flush()` — Immediately invoke the pending flush if one is scheduled.
- `cancel()` — Cancel a pending flush without invoking the callback.
- `scheduled` — `true` when a flush is pending.
- `strategy` — `{ scheduling, supported }`: what was **requested**, and whether this
  runtime can honour it. `supported` is `false` wherever the requested strategy
  needed a platform primitive that is missing and a macrotask was substituted.

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

### Cancellation needs a generation counter here, and that claim was retracted once

A `scheduler.yield()` continuation is already queued the moment it is requested
and returns only a promise: **there is no handle to detach**. So `flush()` and
`cancel()` cannot un-schedule it. Logical cancellation is the first line of
defence — `_run()` opens with `if (!this._scheduled) return`, so an abandoned
continuation that arrives after a `cancel()` finds the schedule closed and does
nothing.

**That is not sufficient, and this subsection previously said it was.** The
first implementation concluded that no generation counter was needed because
removing one left all seven yield-path tests green — an _equivalent mutant_ by
mutation testing, which is normally a good reason to delete machinery nobody can
distinguish from its absence. It was deleted.

It was wrong, and it was wrong in one clause. `cancel()` does clear `_scheduled`
first; **`flush()` does not** — `_run()` clears it, as a side effect of _running_
the flush. So after `schedule(); flush(); schedule()` the flag is true again, the
abandoned first continuation finds a **live** schedule, and runs it. Measured
with a controllable `scheduler.yield`: that sequence left one flush and two
queued continuations, and resuming the abandoned one produced a **second flush
and a nulled `_timer`** — the newer schedule ran early and its handle was
clobbered on the way past. The seven tests stayed green throughout because none
of them resumed an abandoned continuation.

So the counter is here: `const generation = ++this._generation` at the arm,
compared on resumption. The check has to be on the generation rather than the
flag, precisely because the later `schedule()` re-sets the flag. This is
`RES-006`, and the comment in `powerScheduler.js` records the same history — the
retracted claim is kept in both places rather than deleted, so the next reader
who re-derives it finds it already answered.

## `postTask` scheduling, and why it is a fourth strategy rather than a better `yield`

`scheduling: 'postTask'` uses **`scheduler.postTask(fn, { priority, signal })`**
with a **`TaskController`**. It is available in Chromium-family browsers and, as
of 2026, in Firefox; Node does not have it.

Two things it offers that the other strategies do not:

- **A priority.** `'user-blocking'`, `'user-visible'` (the default) or
  `'background'`, set with `taskPriority`.
- **A handle.** `new TaskController()`, passed through `signal`. `abort()` stops
  the task **before it runs** — the platform checks it, so the callback is never
  called at all.

```javascript
const s = new PowerScheduler(flush, {
  scheduling: 'postTask',
  taskPriority: 'background',
});
s.strategy; // { scheduling: 'postTask', supported: true }
```

The handle is the substantive one. It is what lets `cancel()` and `flush()` mean
the same thing on every strategy: **the pending work is actually stopped**, rather
than being made harmless after it arrives. `flush()` therefore aborts the queued
task before running the flush itself, or the same flush would run twice; and
`dispose()` aborts it too, or a task queued against a torn-down scheduler would
run a callback after teardown.

### It needs `TaskController`, not just `postTask`

Both halves are required, and `postTask` alone is the worse of the two worlds:
`postTask` returns a handle with **no `cancel` method**, so a strategy built on it
alone would be _less_ cancellable than the `MessageChannel` macrotask it replaces —
and a feature test that only checked `typeof scheduler.postTask === 'function'`
would pass an implementation that quietly lost cancellation. So
`strategy.supported` is `false` unless `scheduler.postTask` **and**
`TaskController` are both functions, and the strategy falls back to a macrotask
rather than running uncancellably.

Both are detected **once at module load**, alongside `HAS_SCHEDULER_YIELD`, for
the same reason: a stable runtime feature does not need re-probing per flush.

### Where it is missing

Node, and any browser without it. The fallback is a macrotask — the same
degradation `yield` makes, and for the same reason: the flush still happens
promptly, the **ordering** differs, and `strategy.supported` says so:

```javascript
const s = new PowerScheduler(flush, { scheduling: 'postTask' });
s.strategy; // { scheduling: 'postTask', supported: false }
```

It falls back to a macrotask rather than to `queueMicrotask` deliberately. A
microtask fallback would also "still flush", and it is a different ordering —
which is the entire distinction between these two fallbacks and the reason the
unsupported branch is tested for it.

### Why not fold this into `yield`

`scheduler.yield()` is prioritised ahead of the rendering and task queues and is
the right primitive for a scheduler whose job is to run promptly. The temptation
is that `postTask` is the same promise with a priority attached and a real handle,
so routing `yield` through it where it exists would be a strict improvement.

**It was not done that way.** A substitution changes the behaviour of every
caller already on `scheduling: 'yield'` — in an upgrade, with no change to their
code — for a scheduling difference they did not ask for. It would also remove the
generation counter's reason to exist on a path that still needs it where
`postTask` is absent, and it would make the two strategies' cancellation
guarantees differ silently by runtime. A new name is visible in a stack trace, in
`strategy.supported`, and in the options; a substitution is none of those.

What `postTask` genuinely makes unnecessary is the counter **where it is
available**: the platform drops the task, so there is no stale continuation to
recognise. That is why this path reads no generation counter at all — asserted in
`test/powerScheduler.postTask.test.js`, because a counter left in place would be
harmless and would be the thing a future reader believes is load-bearing.

`PowerScheduler` therefore needs no generation counter on this path, and needs one
on `yield`. See [ADR 0010](../adr/0010-a-new-strategy-rather-than-a-better-yield.md)
for the decision, and the `yield` section above for the counter's own history.

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
