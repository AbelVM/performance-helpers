# 0018. Named-export selection is measured, and the benefit does not require it

**Status:** Rejected
**Affects:** `PowerPool` / `powerMessageCodec` — no `name` option is added to `postMessage`
**Evidence:** `node bench/claims.js namedexport`, a new mode added for this row, run 2026-10-13. Two full runs at depth 240 tasks / 10 ms service / 8 workers / 4 task types, plus a 120-task run.

## Context

PISC-009 proposes `postMessage(msg, transfer, { name })` to choose a handler export
from one worker file, and claims it "cuts worker count and memory for pools that
currently spawn one pool per task type". It also names the price: "`name` must
survive the framed envelope, so this is a codec change as well as a dispatch
change."

Two claims, in two different units, so they are measured separately. "Cuts worker
count" is not a number until a worker has a price, and "must survive the framed
envelope" is not a number until the envelope has a cost per message.

## Measurement

A new `namedexport` mode, in three parts.

**Part 1 — what one worker costs.** Measured on the **parent process**, not on the
workers. A `worker_threads` Worker is a _thread_ in the same process, so
`process.memoryUsage().rss` read inside a worker reports the whole process — and
summing that across n workers multiplies the same number by n. The first draft of
this mode did exactly that and reported 16 workers at 3.7 GB, which is n × the
process RSS and not a measurement of anything. The parent's own RSS before and
after is the figure that is actually additive.

| workers | RSS delta | per worker |
| ------- | --------- | ---------- |
| 1       | 14 MB     | 14.2 MB    |
| 2       | 15 MB     | 7.7 MB     |
| 4       | 30 MB     | 7.6 MB     |
| 8       | 69 MB     | 8.7 MB     |
| 16      | 126 MB    | 7.9 MB     |

**Marginal cost per worker: 7.88 MB** (median of the n ≥ 2 rows). The n = 1 row is
higher because it pays the one-time isolate and V8 setup the later ones share.
Time to online is 30–60 ms for a batch, spawned in parallel.

**Part 2 — what carrying `name` costs.** The frame header is six bytes and already
full (version, codec id, uint32 length), so `name` has to ride inside the JSON
payload. It costs a flat **+20 bytes per message**, which is a different fraction
of every payload size:

| payload | plain | with `name` | delta | delta %     |
| ------- | ----- | ----------- | ----- | ----------- |
| 64 B    | 88    | 108         | +20   | **+22.7 %** |
| 1 KiB   | 1048  | 1068        | +20   | +1.9 %      |
| 16 KiB  | 16408 | 16428       | +20   | +0.1 %      |

**The byte column is the figure to quote and the encode column is not.** Measured
over 100 000 iterations × 9 rounds, the plain arm alone spans 2 013–5 120 ns on
this machine — a 2.5× spread — and the delta between the arms flips sign between
rounds. That is the harness's own recorded 28.61 % median min/max spread with
interest. The mode prints the encode time with its noise band beside it and says
plainly that it is below the floor.

**Part 3 — the decisive arm.** Four designs, every task fired at once, 8 workers
total, 4 task types, 10 ms service, 240 tasks. The figure is the **worst-served
task type's p99**, not the mean: a shared pool that is fast on average and slow on
one task type has traded isolation for throughput, and a mean hides exactly that.

| skew | siloed      | siloed/skewed   | shared/type | shared/name |
| ---- | ----------- | --------------- | ----------- | ----------- |
| 1.0  | 1244 ms (8) | 312 ms (**11**) | 306 ms (8)  | 310 ms (8)  |
| 0.7  | 848 ms (8)  | 283 ms (**9**)  | 304 ms (8)  | 305 ms (8)  |
| 0.4  | 488 ms (8)  | 327 ms (**9**)  | 307 ms (8)  | 305 ms (8)  |

`maxTasksPerWorker` is pinned to **1** in every arm. The default is `Infinity`,
and with it every arm finishes in one service period whatever its worker count —
the first draft of this mode measured 13 ms p99 for 240 tasks of 10 ms over 8
workers, which is 300 ms of work on 8 workers and therefore not a measurement of
concurrency at all.

## Decision

`PowerPool` gains no `name` option, and the envelope gains no field.

**The row's premise is true, and it is not attributable to the feature.** A shared
pool does need fewer workers than a siloed design for the same tail — 8 against
9–11 — because a siloed design has a **floor of one worker per task type** while a
shared pool has a floor of one. At full skew that floor is the whole difference:
312 ms on 11 workers against 306 ms on 8.

**But `shared/type` and `shared/name` tie at every skew**, and the tie is the
finding:

| skew | shared/name − shared/type |
| ---- | ------------------------- |
| 1.0  | +5 ms (+1.5 %)            |
| 0.7  | +2 ms (+0.5 %)            |
| 0.4  | −2 ms (−0.6 %)            |

The earlier 120-task run reported the same comparison as −8.6 %, −1.2 % and
+13.4 %. **The sign flips between runs**, which is the evidence that there is no
difference to measure: a worker that dispatches on `handlers[name]` and a worker
that switches on `value.handler` are the same amount of work, and the pool
structure above them is identical.

So the worker-count reduction is real, and it is available **today**, with no
codec change: one worker file whose default export switches on a field in the
payload already consolidates N task types into one pool. The row frames the
mechanism as "choose a handler export from one worker file", but the consolidation
comes from having one pool rather than N, and that does not care how the worker
picks its handler.

### What the feature would actually buy

Not resources. The honest case for `name` is **ergonomics and static safety**: a
named export is a real binding, so a typo is a build error rather than a runtime
`undefined` handler, and tooling can enumerate the handlers a worker offers. That
is a real benefit and it is not what the row claims.

Against it, the measured price is **+20 bytes on every message, forever** — 22.7 %
on a 64-byte payload — plus a protocol version bump, because a v1 receiver cannot
read a frame whose payload carries a field it does not know. A version bump to buy
a binding that `import` already provides is the wrong trade.

## Consequences

- **The consolidation is worth doing and needs no new API.** An operator with N
  task types should use one pool and one worker file that switches on a payload
  field. That is a documentation and example change, not a protocol change.
- **`siloed/skewed` is the control that makes part 3 mean anything.** A uniformly
  sized siloed design is badly provisioned for a skewed workload by construction,
  so comparing it against a shared pool measures _provisioning_, not design. The
  skew-provisioned arm is what shows the shared design's real margin, and it is
  small: 0–7 % on the worst-served type, at equal or fewer workers.
- **A worker costs 7.88 MB marginal RSS.** That is the number any future
  worker-count proposal should be quoted against, and it is now measured rather
  than assumed.

## What survives

The mode. `namedexport` stays in `bench/claims.js` because it is the only
measurement here of what a worker costs, and because the next proposal to
consolidate pools — by named exports, by a dispatch table, or by anything else —
should find the 7.88 MB and the +20 bytes rather than re-derive them.

## Not measured

- **A browser runtime.** `worker_threads` is Node-only, and the row's motivation
  is partly browser main-thread pools. A browser `Worker`'s memory cost is not
  measurable from here, and the 7.88 MB figure should not be quoted for one.
- **Real handler work.** Every handler is `(v) => ({ type, id })`, because the
  measurement is about the pool structure and a handler that did more work than
  another would confound the task type with the work. A workload whose handlers
  differ substantially in cost would change the skew that matters, not the
  conclusion.
- **The porting cost of the codec change itself.** Not estimated, because the
  benefit it would buy is already available without it.
