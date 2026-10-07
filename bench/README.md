# Benchmarks

Lightweight benchmarking helpers for `PowerPool` and `PowerCache`.

This folder contains a small harness (`bench/run.js`) that measures:

- single-threaded CPU-bound compute (baseline) with **p50/p95/p99** per-task latency
- multi-worker `PowerPool` performance across pool sizes with **speedup vs single-threaded**
- a simple `PowerCache` hit/miss benchmark
- `PowerPool + PowerCache` optimized cache reuse patterns
- `PowerPool` autoscaling performance
- `PowerMemoizer` memoization overhead with duplicate keys
- multiple real-world load profiles: `0%`, `25%`, `50%`, `75%`, and `100%` variable load
- additional realistic scenario benchmarks, including:
  - `Burstiness`: sudden bursts of work followed by short quiet periods
  - `Mixed task sizes`: alternating light and heavy work items to mimic uneven request costs
  - `Ramp traffic`: gradual ramp-up and ramp-down of task submission rates
  - `Variable payload sizes`: payloads with different serialized sizes to exercise data movement
  - `I/O bound`: tasks that include small async wait periods to simulate I/O latency
  - `Thundering herd`: many tasks contending for the same cache key at once
  - `Cache hit-ratio sweeps`: low/medium/high reuse ratios for cache-backed work
  - `Cache warmup behavior`: cold vs warm cache performance for repeated workloads
  - `Cache eviction under pressure`: tight maxEntries (20% of unique keys) measuring LRU overhead
  - `Serial vs concurrent getOrSetAsync`: in-flight deduplication benefit quantified
- **helper micro-benchmarks** for primitives not covered by the pool harness:
  - `PowerRateLimit`: tryConsume throughput under rate (all pass) and over rate (~50% rejected)
  - `PowerCircuit`: `call()` overhead in closed (happy path) vs open (fast-fail) state
  - `PowerRetry`: `run()` overhead with 0 retries and 1 retry (baseDelay=0)
  - `PowerSemaphore`: serial (limit=1) and concurrent (limit=8) permit acquisition
  - `PowerBulkhead`: single partition vs 2-partition critical/background isolation
  - `PowerBatch`: individual dispatch (maxSize=1) vs coalesced dispatch
  - `PowerBackpressure`: acquire/release with no pressure and with capacity=100
  - `PowerTTLMap`: set/get throughput with long TTL (no eviction) and short TTL (1 ms, high churn)
  - `PowerEventBus`: `emit` fan-out throughput at 1 / 10 / 50 / 100 subscribers
  - `PowerDeadline`: success path overhead and abort-path cost when task exceeds deadline
  - `PowerSlidingWindow`: `tryConsume` throughput under capacity and at capacity
  - `PowerQueue`: bulk push+shift and interleaved (ring-buffer steady state)
- **historical delta comparison**: on each run, results are compared against the previous `results.json` and regressions/improvements beyond the configured thresholds are highlighted in the markdown (35% + 50ms absolute for pool scenarios, 20% + 8ms absolute for helper micro-benchmarks; see `POOL_PCT_THRESHOLD` / `HELPER_PCT_THRESHOLD` in `run.js`)

Quick usage

```bash
# Run the full benchmark suite (profiles + cache + helpers)
npm run bench

# Run only the profile-based worker-pool benchmarks (across variable load mixes)
npm run bench:pool

# Run only the cache workload
npm run bench:cache

# Run the profile-based pool benchmark directly
node bench/run.js profiles

# Run only the realistic scenario benchmarks
node bench/run.js scenarios
# Run only the helper micro-benchmarks
node bench/run.js helpers

# Alias for the same profile benchmark flow
node bench/run.js variable
```

Environment variables (defaults shown)

- `BENCH_TASKS` (default: `1000`) — number of tasks submitted to the pool (or keys for cache benchmark)
- `BENCH_ITERS` (default: `1000000`) — work per task (higher = heavier per-task CPU)
- `BENCH_POOLS` (default: `1,2,4,8`) — comma-separated pool sizes when running pool benchmarks
- `BENCH_POOL_TIMEOUT` (default: `0`) — ms timeout for each `PowerPool` run; set to `0` to disable timeout and let the pool run to completion
- `BENCH_CACHE_DUPLICATE_KEYS` (default: `10`) — unique key count for cache getOrSetAsync duplicate-key benchmark
- `BENCH_MEMOIZER_DUPLICATE_KEYS` (default: `10`) — unique key count for PowerMemoizer repeated-call benchmark
- `BENCH_POOL_RUNS` (default: `3`) — repeat each pool/scenario variant N times and report the result closest to the median wall-clock time; set to `3` for more stable pool numbers at the cost of a ~3× longer run
- `BENCH_RUNS` (default: `9`) — repeat each helper micro-benchmark N times and report the **trimmed median** (one sample dropped from each end once N ≥ 5); raises to 9 from 5 because at 5 runs a single GC pause moves the reported median by more than most of the deltas this harness is asked to justify
- `BENCH_SEED` (default: `0x5eed1234`) — seed for the workload generator. Every workload — load profiles, task ordering, Box-Muller sampling — is built from this one seeded PRNG, so two runs with the same seed measure the _same work_ and are directly comparable. Set it deliberately when you want a different workload
- `BENCH_HELPER_OPS` (default: `100000`) — operation count for each helper micro-benchmark variant

## `claims.js` — feature claims, not throughput

`bench/claims.js` is separate from `run.js` on purpose. `run.js` measures how fast things are; `claims.js` checks whether a shipped feature does what the release notes say it does.

```bash
node bench/claims.js zipf      # cache admission policies under a Zipf + scan workload
node bench/claims.js sieve     # SIEVE eviction policy, against what ships
node bench/claims.js sketch    # TinyLFU sketch hashing cost, and its distribution
node bench/claims.js window    # admission-window walks on the read path
node bench/claims.js latency   # PowerHistogram quantile accuracy across 4 decades of scale
node bench/claims.js framedecode # incremental decoding against re-concatenating
node bench/claims.js hubencode   # whether the hub's fan-out flush is encode-bound
node bench/claims.js correlation # what awaiting a correlated reply costs
node bench/claims.js batchservo   # does a closed loop beat a fixed flush size
node bench/claims.js concurrency  # is `autoScale.policy` wired to anything
node bench/claims.js stepsize     # does the autoscale step controller beat a fixed step
node bench/claims.js ratelimit    # static versus adaptive refill under burst + steady load
```

Those three were reachable only by reading `bench/claims.js`, which was the only
place they were named. **The block above is a subset, not the full list** — this
file writes up the modes whose results are worth arguing about, and the rest are
covered in `AGENTS.md`. Run any mode with an unrecognised argument and the
generated error lists every mode that actually exists, which is the reliable way
to see them all.

Both report **ratios over a whole run** — hit rate, and quantile relative error — rather than wall-clock. That is not a stylistic choice: `run.js` measures a 28% median min/max spread on a typical machine, so any timing comparison finer than that is noise, while a ratio computed over every operation is immune to how fast the machine is.

The `zipf` workload drives every policy with a **byte-identical seeded key stream**, so a difference between two rows is attributable to the policy rather than to a different input. It also **refuses to run** when `maxEntries` exceeds the working set: a cache that can hold the whole working set has no admission problem, every policy ties near 100%, and the run would prove nothing. Parameters are overridable — `CLAIM_ZIPF`, `CLAIM_WORKING_SET`, `CLAIM_MAX_ENTRIES`, `CLAIM_SCAN_KEYS`, `CLAIM_SCAN_EVERY`, `CLAIM_REPEATS` — and the seed is shared with `run.js` so a result is reproducible.

**`zipf` currently reports a failure.** `admission: 'tynilfu'` is meant to protect a working set from a scan; on a cold cache it does the opposite, measuring a 2.5% hit rate against plain LRU's 66.4%. The release note's original claim for this feature has been withdrawn accordingly. Run the benchmark rather than trusting either the old note or this paragraph.

**`sieve` reports a negative result, and that is the finding.** SIEVE is implemented _in the bench file_, not in `src/`: the claim under test is whether a policy beats what ships, so the policy was measured before the library gained it. It sits beside a hand-rolled plain-LRU **control** that differs from it in exactly one respect — three pointer writes per hit instead of one bit store — and that control reproduces shipped `PowerCache` exactly on both traces, which is what makes the SIEVE row a difference in policy rather than a difference in structure.

It does not pay here. On zipf + scan, SIEVE measures **26.4 %** against LRU's **27.0 %**; scan-heavy, **51.1 %** against **51.0 %** — a tie. The paper's cost claim does not reproduce either: the hit really is cheaper in principle and it is **slower** in practice here (137 ns/op against the control's 105).

Read the row, not just the verdict: **the benchmark is silent on the paper's headline claim.** "No lock on a hit, 2× a 16-thread LRU" is about _concurrent_ caches, and a single-threaded Node run cannot measure lock contention. This measures the portable half — miss ratio — and says only that it does not transfer to these traces. It is not evidence against SIEVE for a lock-contended multicore cache.

Two trace-design notes worth keeping, because both produced wrong numbers before the right one. The working set must **exceed** capacity: the first scan-heavy run used 300 against 500 and every policy survived 300/300, so the scan fit in the slack and nothing was ever evicted — the comparison was vacuous. And SIEVE's hand is **persistent and one-way**; resetting it per eviction is a CLOCK sweep, a weaker policy that is not SIEVE, and it reported a 5-point loss. Hit rates here are deterministic — same seed, identical survivors across runs — so only the ns/op column moves.

Parameters: `CLAIM_SIEVE_CAPACITY`, `CLAIM_SIEVE_SEED`, `CLAIM_SIEVE_WORKING`, `CLAIM_SIEVE_SCAN_EVERY`, `CLAIM_SIEVE_SCAN_KEYS`, `CLAIM_SIEVE_ZIPF`.

**`batcheservo` reports that a closed loop should not be added to `PowerBatch`, and
that is the finding.** It drives a real `PowerBatch` with a bursty producer — 60
bursts of 9, added synchronously, because awaiting each `add()` drains the
microtask queue and makes every flush one item long — and compares a fixed
`maxSize` against proportional, PI, and PI+feedforward resizing driven from the
real pending count. **The fixed size is already exact: mean |err| 0.00 against a
target of 12, 45 handler calls.** There is no error for a controller to reject,
and the reason generalises past this helper: `PowerBatch` is already a closed
system, `add()` flushes the moment the queue reaches `maxSize`, so the pending
count is bounded by the size itself. Both controller failures are diagnostic —
P undershoots (5.00) because proportional action tracks error instead of
anticipating the burst, PI overshoots (21.60) because the integral winds past a
target it was already hitting, and **feedforward is identical to PI** (same 21.60,
same 25 handler calls) because the burst is already flushed by the time the
controller resizes, so the open-loop term arrives after the event it was meant to
anticipate.

Three harness defects had to be fixed before that was a result rather than a
number, and the first two both looked like findings. Awaiting each `add()` gave
four identical `1.00x` rows — a degenerate experiment. Then feeding the
controller a running tally of adds rather than the pending count made every policy
see a permanent enormous error and collapse the batch to ~1 item per flush. A
benchmark whose control prints `NaNx` is a broken benchmark, and that is how the
zero-denominator case surfaced; the ratio column now distinguishes `exact` from
`worse`.

**Historical pre-wiring result:** the `concurrency` run reported that
`autoScale.policy` was not wired, and that enforcing it would lose. Two
questions, in that order, because the first made the second answerable. The
pool now enforces admission for `aimd`, `vegas`, and `gradient2`; these numbers
describe the implementation before that wiring and should not be read as a
current runtime claim.

_Is the controller consulted?_ Four policies, identical workload, the pool exactly
as it ships, 2000 ms per arm, 5 repeats, medians: `ewma:a=1720, ewma:b=1616,
aimd=1720, vegas=1736, gradient2=1664` — **noise floor 6.4 %, cross-policy
7.4 %**. `ewma:a` and `ewma:b` are the _same configuration_, so the spread between
them is this run's own noise and is the same magnitude as the spread across all
five policies. Meanwhile `concurrencyLimit` differs per policy and is stable
within each (`null`, then 7.59–7.67, 7.91, 7.16–7.66): the controller runs, its
belief changes, and nothing consumes it. That matches the read — `_adaptiveLimit`
is written by `_updateAdaptiveLimit()` and read by `getStats()`.

_Would enforcing it help?_ The bar is not "better than nothing" — the pool already
has a limit of sorts — so the control is a **sweep of constants**, compared against
the best of them. A controller that only beats a badly-chosen constant has not
earned a getter. `shipped:a=1888, shipped:b=1896` (noise floor **0.4 %**),
`enforced:aimd=1864` (0.99x, peak 8), `enforced:gradient2=1688` (0.89x, peak 4),
constants `1=424, 2=864, 3=1184, 4=1760, 6=1936, 8=1936`. Best constant
`constant:6 = 1936`, best enforced `enforced:aimd = 1864`, so **enforced is
−3.7 % against the best constant** — far outside the noise floor, which makes it a
result rather than an absence of one. The sweep shows why: throughput climbs
steeply to a cap of 6 and is flat from 6 to 8, because the pool has 4 workers and
anything at or above that keeps them busy. **A cap at or above the worker count is
free; below it costs proportionally.**

Read the row, not just the verdict. This shows the controller is not better _on
this workload_, where the binding constraint is worker count and the correct limit
is "do not constrain". It does not show it could never help: a limit only matters
when queueing depth or memory is the constraint, and neither is under test. The
honest options are to document `policy` as reported-only or to drop it — **not to
keep tuning until the controller wins.**

The noise-control arm is the load-bearing part, not a nicety. An earlier version
reported a **0.0 %** cross-policy spread and looked conclusive; three consecutive
runs of that same version gave **16.7 %, 5.7 % and 27.3 %**, because it had no
same-policy control and its variance was the harness rather than the machine.
Nothing in that version could have told a real effect from a noisy afternoon.

Four defects had to be fixed before any of those numbers was real, and three were
shapes guessed rather than read. A hand-rolled fake worker never satisfied the
framed response protocol, so every awaited post hung — the envelope handling is
now copied from `EchoWorker` verbatim, the same mistake having been made twice.
`awaitResponseTimeout: 0` was read as "no timeout" when it means _time out
immediately_, so every counted completion was a rejection. The gate was a
check-then-act race — `await room(); pending += 1` yields a microtask, so every
racer evaluated `pending < cap` before any of them incremented it; measured,
`admitted == inflight` for every cap including 2, and two "enforced" arms came out
25x apart on a cap that was never applied. The slot is now claimed inside the
admission decision, and **the mode checks its own gate before printing any ratio**
(`gate held (peak N <= cap M)`) and returns without printing if it did not hold.

The conclusion rule needed an absolute materiality threshold, not just the noise
comparison: `cross > floor * 1.5` duly reported a 1.3 % spread — twenty-four
admissions out of 1920 — as "an effect larger than the noise floor". Raw medians
are printed so a reader can judge rather than trust a threshold.

**`stepsize` reports that the autoscale step controller eliminates overshoot.**
`2498c7d` made `stepUp`/`stepDown` a ceiling and let `PowerServo` choose the step
within it; nothing measured whether that was an improvement until this mode. It
compares the shipped `_autoscaleSteps` against the pre-`2498c7d` rule
**reconstructed in the bench file** — the same reason `sieve` implements its policy
here rather than in `src/`: the claim under test is whether the shipped thing beats
what it replaced, so the thing it replaced has to exist. Monkey-patching one method
is also the narrowest possible difference; the two arms share every line of pool
code except the step rule.

Step ceiling 4, fleet 1..16, three identical `fixed` arms against one `servo` arm:
peak / final / overshoot of **5 / 1 / 4** against **3 / 3 / 0**. The noise floor,
taken from three runs of the _same_ configuration, is **0.0 %** — they agree
exactly — against a cross-arm spread of 100 %. **Overshoot is eliminated.**

Throughput is deliberately **not** the metric. A fixed step of 4 reaches a large
fleet in fewer ticks by arithmetic rather than merit; what it cannot do is avoid
overshooting when one worker was needed, and that is what separates them.

**Two caveats, and both are printed by the mode itself rather than only here.**
Neither arm ever stopped moving, so "ticks to settle" is uninformative — with
`cooldownMs: 0` and a modelled signal the fleet hunts rather than rests, and the
fixed arm ends at 1 after peaking at 5 because it overshoots on the way up _and_
all the way back down. And the latency signal is **modelled from the fleet size**
(`base + load/fleet x slope x 4`) rather than measured from a dispatch loop, which
narrows the claim to the decision rule given a latency reading — the variable under
test — rather than to the whole pool.

The self-check earned its place immediately. An earlier version planted work in
`pool.queue` and called `_autoScaleTick()` directly, which never completed a task:
`_ewmaLatency` stayed null, both arms short-circuited on the `ewma == null` guard,
and the mode reported `servo: [4]  fixed: [4]` — a treatment identical to its
control. That is precisely what a self-check exists to catch, and it is why the
mode stops rather than printing a null result dressed as a finding.

Parameters: `CLAIM_STEP_ARMS`, `CLAIM_STEP_REPEATS`, `CLAIM_STEP_TICKS`,
`CLAIM_STEP_BASE_MS`, `CLAIM_STEP_SLOPE_MS`, `CLAIM_STEP_TARGET_MS`,
`CLAIM_STEP_LOAD`.

Parameters: `CLAIM_CONCURRENCY_BUDGET_MS`, `CLAIM_CONCURRENCY_REPEATS`,
`CLAIM_CONCURRENCY_SERVICE_MS`, `CLAIM_CONCURRENCY_INFLIGHT`, and for
`batcheservo` `CLAIM_BATCH_SERVO_TARGET`, `CLAIM_BATCH_SERVO_BURSTS`,
`CLAIM_BATCH_SERVO_BURST`.

**`sketch` reports the hashing cost of the TinyLFU sketch, and one number that is not
a timing.** The sketch now hashes a key once per `increment`/`estimate` rather than once
per row, which was `depth` string coercions and `depth` FNV passes. It also prints a
**distribution** row, and that is the part to read first.

A hash refactor is the one edit that can silently degrade an admission filter: the bucket
assignment shifts and every test stays green. So the mode computes the collapsed
counterfactual _in the same run_, at a fixed seed, by pinning the private `_indexFor` to
row 0 — which _is_ the mutation, and cannot drift from the real code the way a hand-rolled
re-implementation can. (The first version of this mode re-implemented the hashing by hand
and reported 287 against the library's 484, i.e. it was not measuring the thing it
claimed to. Both sides now come from the same code and the same seed.)

Independent rows report a **lower** frequency than collapsed ones, which is the entire
point of count-min. If that ever inverts, the sketch is effectively one row deep and the
faster hashing bought nothing that matters.

Parameters: `CLAIM_SKETCH_ITERATIONS`, `CLAIM_SKETCH_KEYLEN`.

**`window` reports a gap that is measured and not yet closed.** The TinyLFU admission
window is the contiguous suffix of the list, so `_windowOldest()` walks back from the
tail — O(windowSize) — and it runs on **every main-space `get()`**:

| `windowSize` | window walks per `get()` | walk steps |    ns/get |
| -----------: | -----------------------: | ---------: | --------: |
|            0 |                     0.00 |          0 |       133 |
|           10 |                     1.00 |          9 |       279 |
|          100 |                     0.98 |         97 |       670 |
|         1000 |                     0.80 |        799 | **2 236** |

**16.8× per `get()`**, and the walks-per-get ratio is the fraction of reads landing in
main space rather than the window, which is why it falls below 1 as the window grows.

Two things to read before changing this. First, **the window only exists under
`admission: 'tinylfu'`** — `_windowSize` is forced to 0 otherwise, so the first version
of this mode measured nothing and reported a flat ~200 ns, concluding the row was stale.
Second, `powerCache.js:514` records that a previous attempt at a maintained window
pointer _"got it wrong"_ and was reverted; the field it left behind, `_windowStart`, is
assigned `null` in two places and never read. This is not a new design, it is a second
attempt at one that has already failed once, and the walk counts above are the check that
would tell you whether the retry worked.

Parameters: `CLAIM_WINDOW_ENTRIES`, `CLAIM_WINDOW_RESIDENT`, `CLAIM_WINDOW_READS`, `CLAIM_WINDOW_SIZES`.

The same mode also benches the **generational two-`Map`** structure (`quick-lru` / `hashlru`), and that row is the more interesting one. At the configured `maxEntries` it shows the largest number in the table — **+13.0 points** over LRU on scan-heavy — and gets there by **peaking at 1003 entries against a configured 500**. That is the row's own "up to 2x over-fill" bound, reproduced exactly. Sized so its peak lands at 502 instead, it scores **35.5 %** against LRU's 51.0 %: **the entire margin was the memory.**

Read the `peak` column before the verdict, always. For `PowerCache` specifically, `maxEntries` is not a memory hint but a contract — `_evictIfNeeded` loops while `_map.size > this.maxEntries` and `stats().size` is public — so a structure holding 2x `maxEntries` breaks a published guarantee rather than exceeding a soft one. `bench: generational @ half cap` exists for exactly this comparison; without it the full-capacity row reads as a win.

What survives is the structural claim, which was the genuinely new part of the proposal: no cursor and no node pool makes CACHE-001 _structurally_ impossible rather than merely unreachable-by-inspection. That is a real property — and CACHE-001 is closed as not reproducible, so it prevents a bug that does not exist.

## `baseline.js` — a timing gate that knows it is on a machine

`run.js` measures a 28% median min/max spread on a typical machine, so a hand-written "within ±20% of the committed baseline" gate is not a weak gate — it is an unreliable one, and the fastest way to get a flaky gate ignored is to ship one. This is the gate that was specified anyway, with the threshold **derived rather than chosen**.

```bash
npm run bench:baseline       # measure this machine and record its baseline
npm run bench:gate           # measure and compare; exit 1 only on a reproduced regression
npm run bench:baseline:show  # print the recorded baseline
```

Three things make it different from the ±20% version:

- **The threshold is each site's own recorded spread**, so a clean tree passes by construction and a site calibrated at 80% spread is not held to the same bar as one at 8%. A constant chosen in advance is a coin flip; a threshold measured on the machine is a measurement.
- **Baselines are per-machine and gitignored**, in `bench/baselines/<hash>.json`. The key hashes hostname, platform, arch, CPU model, core count and Node version. A committed absolute baseline is a claim about every other machine's hardware, which is the mistake this design exists to avoid — and the files end up in CI artifacts, so the hash keeps a hostname out of them.
- **There are three answers, not two.** A run is `PASS`, `FAIL`, or `INCONCLUSIVE` — and _inconclusive is never a failure_. It covers both a machine whose level has drifted (the median delta across all sites is the signal, so one real regression cannot hide inside it) and a machine noisier than it was calibrated. Measured during development: a clean tree reported six unrelated helpers 44–48% slower than a baseline recorded minutes earlier, and a gate that failed on that would have been wrong.
- **A drift cannot delete a failure, and it cannot manufacture one either.** A site counts as a regression only if it moved **further than the machine's own median move**. Six sites all at +50 % is the machine, six times over; one site at +300 % in a run whose median moved +40 % is not, and the verdict is `FAIL` either way the drift is read. The sites a drift _does_ explain are reported as explained rather than dropped — the run says how many, so the count and the lines underneath it describe the same set of sites.
- **A site too noisy to judge is named, not dropped.** A band that widened past 1.25× what it was calibrated at is excluded from the verdict — a band that wide cannot support one — but it is listed with both spreads and the reason. This is the class of regression the gate was previously blind to: an added allocation or a growing `Map` does not make a site reliably slower, it makes its band _wider_ first, and a wider band used to remove the site from the comparison with nothing said. Such a run also usually trips the harness-wide noise check, so the verdict is `INCONCLUSIVE` rather than `PASS` — "unjudgeable" is not "nothing moved".

A `FAIL` also **re-measures before reporting**. Nine samples, trimmed one from each end, still admits a GC pause landing on one measurement — one site out of 25 came back +48.9% against a 7.8% threshold on an unmodified tree. A real regression is still there on the second run; a blip is not, and the gate says `INCONCLUSIVE` rather than failing. It costs a second pass only when something was already reported, and nothing at all when the tree is clean.

**Mutation-checked, because a gate that always passes is worse than none.** A deliberate second `get` inside `PowerCache.get` is caught and reproduced (`cacheHitMs: 9.9 ms → 16.0 ms, +62%` against a 17.6% threshold); a clean tree is not. Two versions of this gate failed that check first — one that had no cache site to move at all, and one whose threshold arithmetic turned a 60% band into a 3000% allowance. The sites it guards are `PowerCache` (`get` on hits, `set` on misses) and `PowerThrottle.tryConsume`: the two the item names, and the two that had no band.

The gate measures the harness's `helpers` mode only. The full run takes the better part of an hour, which is too long to run before landing a change, and the pool scenarios are dominated by worker start-up and message transport, where the spread is far wider. Override with `BENCH_GATE_MODE=all` for a change big enough to want the slower run.

CI has no baseline to compare against on a fresh runner, so `bench:gate` **exits 0 and says so** rather than failing a run it cannot judge. Cache `bench/baselines/` as an artifact to get a real verdict.

## Reading a run honestly

Every generated report opens with a **Measurement quality** section, and it is the part to read before any number in the file:

- **The seed** tells you whether two runs are comparable at all. Before the seed was fixed, every workload came from `Math.random()`, so two runs measured two different workloads and no delta between them was meaningful — repetition reduces timer noise, not workload noise.
- **The noise floor** is the median min/max spread across all timed variants. A claimed improvement smaller than this is **not measurable at this sample count**, and raising `BENCH_RUNS` is the first thing to try. On a busy machine this number is easily above 20%, which is worth knowing before arguing about a 5% change.
- **Whether `global.gc()` ran.** The `bench*` npm scripts pass `--expose-gc`; invoking `node bench/run.js` directly does not, and the report says so explicitly. Without it, each phase is measured on the previous phase's uncollected garbage, and `memDeltaKb` inherits phantom memory cost from the helper before it.

The outlier policy is a **symmetric** one-from-each-end trim, not "discard anything slow". A GC pause only makes a run slower, so a one-sided rule would delete the most important noise source in a Node benchmark while leaving a pathologically fast run to distort the median in the other direction.

Tips and notes

- Start with small values during iteration: `BENCH_TASKS=2 BENCH_ITERS=10000` to validate changes quickly
- Use `BENCH_HELPER_OPS=10000` for a fast smoke test of all helpers, and `node bench/run.js helpers` to run _only_ the helper micro-benchmarks — the pool and scenario phases dominate wall-clock time, and `helpers` is the fast way to iterate on them
- Use `BENCH_POOL_TIMEOUT=0` when you expect long runs and don't want the harness to fall back to the plain `worker_threads` implementation
- Use `BENCH_POOL_RUNS=3` for more stable pool benchmark numbers on a noisy machine (runs each pool variant 3 times, reports median)
- Use `BENCH_RUNS=15` or higher when you need to resolve a small delta; check the reported noise floor to confirm it worked
- The harness writes human-readable results to `bench/results.md` and writes a machine-readable copy to `results.json` at the repository root; the markdown contains a link to that file

Example quick smoke run

```bash
BENCH_TASKS=2 BENCH_ITERS=10000 BENCH_POOLS=1 BENCH_POOL_TIMEOUT=0 BENCH_HELPER_OPS=1000 node bench/run.js pool
```

Reproducibility

- Run the same `BENCH_TASKS`, `BENCH_ITERS` and `BENCH_POOLS` across machines to compare relative performance
- Benchmark results are noisy on shared machines; run multiple times and take median/mean as appropriate
- The `Δ prev` column in the markdown shows changes relative to the previous `results.json` on disk — commit `results.json` to track regressions over time
