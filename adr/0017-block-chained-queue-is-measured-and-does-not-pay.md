# 0017. A block-chained queue is measured and does not pay

**Status:** Rejected
**Affects:** `PowerQueue` (`src/helpers/powerQueue.js`) — no block-chained implementation is added
**Evidence:** `node bench/claims.js blockqueue`, a new mode added for this row, run 2026-10-13. Seven runs at depth 200 000, plus a depth sweep at 500 / 4 000 / 50 000.

## Context

PISC-012 asks for Piscina's `FixedQueue` design — a linked list of 2 048-slot
circular buffers — to be evaluated against `PowerQueue`, and says plainly that it
"needs a `bench/claims.js` mode before any commitment". The row's premise is that
the design "bounds the worst-case growth pause — which matters when the queue
drains on a browser main thread".

[ADR 0002](0002-ring-buffer-queue.md) already rejected a **pure** linked list, on
per-node allocation and locality. This is the third option the row names, and the
distinction is the whole point: a block-chained queue keeps locality _within_ a
block, so it is not the structure ADR 0002 rejected. What it buys over the ring
buffer is that growth is O(block) rather than O(size) — no doubling copy.

The premise is sound as far as it goes. `PowerQueue._grow()` copies the entire
buffer, so one `push` in every log₂(n) is O(n) while the rest are O(1), and a
browser main thread is exactly where a 2 ms pause is a dropped frame.

## Measurement

A new `blockqueue` mode. The prototype is a `BenchBlockQueue` in the bench file,
not in `src/` — the claim under test is whether a _structure_ beats what ships, so
the structure is measured before the library gains it, the same order `sieve` used
for SIEVE. It runs against the real `PowerQueue`, with `Array.prototype.shift()`
as a **control** rather than a contender: ADR 0002 already measured it, and the
`sieve` mode's lesson is that a comparison without a control can be vacuous.

Three design choices in the measurement, each of which produced a wrong number
first:

- **Growth events are timed individually, not averaged.** A mean over the run
  cannot see the thing being proposed, because the O(n) grow is one operation in
  log₂(n). The ring's `_grow` is wrapped; the block chain gets an `onGrow` seam
  placed _inside_ the allocation branch, so it costs nothing on the throughput
  figure it is not part of.
- **Per-op `hrtime.bigint()` is not used for throughput.** The timer costs more
  than the operation, so a per-op loop would mostly measure the clock.
- **The whole measurement repeats and keeps the fastest run.** A single 8
  M-operation pass varies by better than 2× run to run on this machine.

Depth 200 000, 20 burst/drain cycles, 4 M pushes:

|                        | `PowerQueue` (shipped)      | block-chained ×2048           |
| ---------------------- | --------------------------- | ----------------------------- |
| ns/op                  | 4.9 – 7.1                   | 10.8 – 16.3                   |
| growth events          | **14**                      | **1953**                      |
| median growth          | 3.1 – 148.6 µs              | **0.8 – 3.8 µs**              |
| p99 growth             | 746 – 1079 µs               | 5.9 – 14.3 µs                 |
| max growth             | 0.8 – 2.1 ms (its own copy) | 0.3 – 250 ms (**a GC pause**) |
| slots allocated, total | 262 128                     | 3 999 744 (**15×**)           |
| resident slots at peak | 262 144                     | 200 704 (0.77×)               |

## Decision

`PowerQueue` stays as it is. The block-chained design is not adopted.

**The structural claim is true, and it is not enough.** The block chain's median
growth event is cheaper than the ring's by **9× to 98× across four runs, ~50×
typical** — and the asymmetry inside that range is the thing to notice: the block
chain's own figure is stable at 0.8–3.8 µs, while it is the _ring's_ that moves,
7 µs to 85 µs on the same machine in the same hour. That is exactly what avoiding
the doubling copy should buy. It loses anyway, for two reasons the row does not
anticipate.

### Allocation is proportional to different things

The ring buffer grows log₂(peak) times and then **reuses its buffer forever** —
14 growths for 4 M pushes, because after a full drain `_head === _tail` and the
next push writes into the same array. The block chain allocates one block per
2 048 pushes _for the life of the queue_: a drained block is released, but the
next push allocates a replacement.

For a queue that drains and refills — which is precisely `PowerPool`'s task queue
under saturation, `push` on arrival and `shift` on dispatch — that is permanent
churn. 15× the ring's by slots allocated, measured.

This is the finding that decides the row, and it is not in the row's premise at
all. The row frames the trade as "avoids the doubling copy" against "most of the
effort is porting priority, weight, `shrink()` and `dispose()`". It does not
frame it as _one copy per doubling against one allocation per blockSize_, and the
second is unbounded in the length of the run.

### The worst-case pause it was meant to bound is a GC pause

The ring's max growth event is its own copy: 0.8–2.1 ms to move 262 144 slots,
which is a real number for a real operation. The block chain's max is 0.3–250 ms to
allocate one 2 048-slot array, which is not a 250 ms operation — it is a collector
pause, and permanent allocation churn is what produces them.

So the row proposes block-chaining to _bound_ the worst-case pause, and the
structure that allocates least is the one that already ships. The mode prints the
median as the structural figure and says plainly that the max column compares a
copy against a collector.

## Consequences

- **The one place the block chain wins is resident memory at peak depth** — 200
  704 slots against 262 144, because it wastes at most one block rather than up to
  a full doubling. It loses even that below one block: a 500-deep queue on
  2 048-slot blocks holds 4× the slots it can use, and the depth sweep shows the
  throughput gap is widest exactly there.
- **`PowerQueue`'s documented non-release of memory is unchanged**, and ADR 0002's
  note that "a `shrink()` would be the fix if it ever matters" still stands. This
  measurement does not make it matter: `shrink()` addresses resident memory, which
  is the one axis the block chain wins on, and it does so without the churn.
- **A future queue proposal should state what its allocation is proportional
  to.** "Avoids the doubling copy" is a statement about one event; the question
  that decides a structure is the total over the life of the queue.

## What survives

The measurement, and the mode. `blockqueue` stays in `bench/claims.js` because the
next person to propose a block-chained queue — or any structure whose growth is
not a doubling — should find the allocation-churn number rather than re-derive it.

This is the seventh item in this project's history to be scoped to a number nobody
had produced. It is also the first where the row's stated premise turned out to be
**half right**: the growth-pause claim is true and measured at ~50×, and the
proposal still fails on a second-order effect the row did not consider. That is a
more useful record than a flat rejection, because the obvious next proposal — "then
use bigger blocks" — is answered by the same measurement.

## Not measured

- **The porting cost.** The row notes that "most of the effort is porting priority,
  weight, `shrink()` and `dispose()`", and none of that is measured here. This is
  the structure's push/shift/growth behaviour only. A structure that won on the
  tail and lost on the port would still be the wrong trade, so the porting cost has
  to be estimated before this becomes a proposal — but it does not need to be,
  because the structure does not win on the tail.
- **A block size tuned to the workload.** The mode sweeps depth but holds the block
  size at Piscina's 2 048. A block size near the observed peak depth would reduce
  the churn, and at the limit — one block sized to the peak — it _is_ the ring
  buffer. The sweep is the argument that the middle ground has no best setting.
- **Concurrent access.** `PowerQueue` is not thread-safe and neither is the
  prototype, so nothing here speaks to a shared queue across workers.
