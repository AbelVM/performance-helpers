---
'performance-helpers': patch
---

### Added

`postMessage` accepts a per-task `signal` — an `AbortSignal`.

```js
const ac = new AbortController();
const pending = pool.postMessage(task, undefined, { awaitResponse: true, signal: ac.signal });
ac.abort(); // the caller stops waiting, immediately
```

`AbortSignal` is a web standard, so this transfers cleanly across realms — which is the
whole reason it is the right mechanism here rather than a pool-specific cancellation
token.

Three cases, and the third is the one worth reading:

- **Already aborted at post time** — refused before any queue work, because a caller
  holding an aborted signal has already changed their mind. Fire-and-forget returns
  `false` rather than throwing, matching every other refusal on that path.
- **Aborted while queued** — the pending response is rejected _at abort time_, not at
  dispatch time. The item is deliberately **not** removed from the queue: neither queue
  implementation has an efficient remove-by-value, and the dispatch loop already walks
  past items it is going to discard — the same trade the existing `deadlineAt` path
  makes. The cost is one held slot until dispatch; the alternative is an O(n) scan on
  every abort, on the saturated path this release exists to make cheaper.
- **Aborted while in flight** — **the work runs to completion and the waiter is
  released now.** Piscina terminates the worker; that is the wrong trade here. Under
  `maxTasksPerWorker > 1` a worker carries several in-flight tasks, so terminating it to
  abandon one kills every other task on that worker — a blast radius far larger than the
  task being aborted, and one the callers of those other tasks did nothing to earn. It
  also discards a warm worker and its negotiated protocol state. The response is
  discarded when it arrives, because the pending entry is already gone.

That is the honest reading of what an abort usually means — "stop waiting for this" — and
a caller who genuinely needs the work undone has to arrange that in the worker, because
no pool can undo a side effect.

**`skipQueue` is rejected as part of this change** (the F-2 design question the row
names). The pool already dispatches immediately when a worker is free; the queue is only
used under saturation; and a `skipQueue` that jumped ahead of queued work would be a
priority mechanism by another name when `priority` already exists.

### Changed

- `PostMessageOptions` now declares `deadlineAt`, which the pool had been reading
  undocumented. A task already in flight is not affected by it: the deadline is checked
  at dispatch, so it bounds queueing delay and not execution time.

### Tests

8 tests in `test/powerPool.abortSignal.test.js`, mutation-checked 6 of 6 — the
dispatch-loop check, both listener attachments, the already-aborted guard, the
`{ once: true }` options, and the direct-dispatch signal threading.

The fire-and-forget case is the one that matters most and is the easiest to get wrong: it
is the only cover for the dispatch-loop check, because the queued listener is attached
only when there is a promise to settle. Reverting that check passes every other test in
the file — which is how the first mutation run read 4/6 and looked fine.

Six bugs in the first draft of those tests were caught and fixed, and the shape is worth
recording because it recurred: an assertion on a counter that moved for an unrelated
reason, an exact listener count that included calls the test did not mean, a spy on
`AbortController.prototype` (which has no `addEventListener` — it is on
`AbortSignal.prototype`, and the spy _threw_ rather than failing), an assertion on
`AbortSignal.listenerCount` (which does not exist in this runtime), an invalid
`this` type annotation, and an unused binding.
