---
'performance-helpers': minor
---

### Added

An injectable `now` option on the four clock-driven helpers that lacked one:
`PowerDeadline`, `PowerCircuit`, `PowerCron` and `PowerEventLoopMonitor`.

MapLibre GL JS exposes `now()`, `setNow()`, `isTimeFrozen()` and `restoreNow()` so
an application can freeze time and get deterministic rendering and deterministic
tests. These four helpers read the module clock directly, so a frozen clock had no
effect on any of them — and `PowerCircuit` had no injection point at all, which
made it the one helper a caller could not drive from their own clock by any means.

This is not a performance gap, it is an integration gap, and it is the kind that
makes a library feel foreign in an ecosystem: the host has a time-freezing
convention and we did not honour it.

The scope was corrected during implementation. An earlier revision of the analysis
listed ten helpers as having no injection point; reading the source showed six
already accept `now` — the four limiters via `attachLimiterClock`, plus
`PowerTTLMap` and `cache/core`, both of which carry a comment citing PERF-007. The
real gap was four. The lesson is the one `AGENTS.md` records about guessed shapes:
_read the code before writing the list._

`PowerCircuit` defaults to `monoMs()`, which `src/utils/now.js` documents as
deliberately unmovable — it never reads `Date.now()`, so a harness that fakes the
wall clock cannot drive it. Injecting a clock is the only way past that for this
class, and it is now the documented one.

The 141 ns `nowMs()` measurement that PERF-007 and RES-019 are built on is not in
the path: each helper resolves `this._now` once in its constructor and calls it,
which is one property lookup — the same shape `PowerTTLMap` and `cache/core`
already use.

### Tests

`test/geoClock.injection.test.js` — 15 cases driving each helper from a clock the
test owns, which is the only way to assert deadline and window behaviour without
sleeping. Two of them pin failure modes worth recording:

- A **frozen** clock does not work for `PowerEventLoopMonitor`: `_record` drops
  negative drift readings as a backwards clock, and a frozen clock makes every
  reading `now - scheduledFor` negative, so nothing is ever sampled. The clock has
  to track real time and be jumpable.
- `PowerCircuit`'s drawn open window is jittered between `timeout × 0.5` and
  `timeout` (`DEFAULT_CIRCUIT_MIN_JITTER_RATIO`), so an exact boundary assertion is
  a coin flip. The test asserts the two ends the jitter cannot cross.
