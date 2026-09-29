---
'performance-helpers': minor
---

Adds a per-machine performance-regression gate, and closes TEST-006's remaining
half.

The item specified "a coarse CI check: `PowerCache.get` and
`PowerThrottle.tryConsume` within ±20 % of a committed baseline". That is not
what shipped, because it cannot work: BENCH-001 measured a **28.61 % median
min/max spread** (p95 85 %) on this machine, so a ±20 % gate would fail on a
clean tree about as often as it passed. The fastest way to get a flaky gate
ignored is to ship one.

What shipped is a gate whose threshold is **derived rather than chosen**:

```bash
npm run bench:baseline       # measure this machine and record its baseline
npm run bench:gate           # measure and compare
```

- **The threshold is each site's own recorded spread**, so a clean tree passes
  by construction and a site calibrated at 80 % spread is not held to the same
  bar as one at 8 %.
- **Baselines are per-machine and gitignored**, in `bench/baselines/<hash>.json`.
  A committed absolute baseline is a claim about every other machine's hardware.
- **Three answers, not two.** `PASS`, `FAIL`, or `INCONCLUSIVE` — and
  _inconclusive is never a failure_. It covers a machine whose level has drifted
  (detected by the median delta across all sites, so one real regression cannot
  hide inside it) and one noisier than it was calibrated.
- **A failure re-measures before it is reported.** Nine samples trimmed one from
  each end still admit a GC pause landing on one measurement; a real regression
  survives the second run and a blip does not.

**Mutation-checked, because a gate that always passes is worse than none.** A
deliberate second `get` inside `PowerCache.get` is caught and reproduced
(`cacheHitMs` 9.9 ms → 16.0 ms, +62 % against a 17.6 % threshold); a clean tree
is not. Two earlier versions of this gate failed that check and were fixed
rather than shipped:

- One had **no cache site to move at all**. The helper benchmarks covered twelve
  helpers and neither `PowerCache` nor `PowerThrottle` was among them — the two
  the item names. It passed a deliberate constant-factor slowdown in
  `PowerCache.get` and reported `PASS`. Both are now measured, through the same
  `benchVariantRepeat` trimming as everything else.
- One turned a site's recorded 60 % band into a 3000 % allowance through a
  units error, and passed a 64 % regression.

Also:

- `bench/run.js` writes `measurement.bands` — every per-site median, min, max
  and spread — into `results.json`. Previously only the aggregate survived,
  which made per-site gating impossible.
- `test/benchBaseline.test.js` covers the decision logic: pass, fail, both
  inconclusive paths, the per-site threshold being the recorded spread, and a
  single regression not being hidden by the machine-shift check.
- The gate measures the harness's `helpers` mode. The full run takes the better
  part of an hour, which is too long to run before landing a change;
  `BENCH_GATE_MODE=all` overrides.
- On a fresh CI runner with no baseline, `bench:gate` exits 0 and says why. A
  missing measurement is not a regression, and exiting 1 would put a red X on a
  run that told the truth.
