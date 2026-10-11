---
'performance-helpers': minor
---

### Added

Three `bench/claims.js` modes that settle questions the geospatial ecosystem keeps
guessing at. All three were added for
[ADR 0015](../adr/0015-geospatial-scope.md); before they existed the questions had
no answers either way.

- **`geoencode`** — four arms on one payload, in a real worker, on the real call
  path: `JSON.stringify` → post string → `JSON.parse`; structured clone of the
  object graph; structured clone of a flat `Float64Array`; zero-copy transfer of
  that buffer. Measured on the MapLibre #106 shape (200 LineStrings × 4,500
  coordinates) and on 200k points.

  The stringify measurement — **196.69 ms** — independently confirms MapLibre
  #106's reported _"about 200ms"_ on the same payload shape, on a different
  machine and a different V8. That the harness reproduces a number reported by
  someone else is the strongest available evidence that it models the real call
  path rather than a synthetic one.

  Three findings, and the third is the one that matters:

  1. **Structured clone of the object graph is _slower_ than JSON** (393.75 ms
     against 296.91 ms). The obvious "just `postMessage` the object" answer is
     worse than what MapLibre already does.
  2. **A flat buffer is 47× faster than the object graph** on the #106 shape and
     232× on points.
  3. **The win is flattening, not transferring.** Cloning a _flat_ buffer (1.66 ms)
     is within timer resolution of transferring one (~1.3 ms after subtracting the
     7.06 ms build). Chrome's ~46× transfer figure does not reproduce at this
     size.

- **`geocoalesce`** — a coalescer against `PowerBatch` + a `Map`, measuring diff
  _quality_ (mutations coalesced, mutations dropped, drop policy honoured) rather
  than latency alone. **The rejection condition fired:** at every window swept
  (1/2/4/16 ms) the coalescer is at best equal to `PowerBatch` + a `Map` on work,
  and it always applies fewer mutations — 1,716 against 1,961 at a 16 ms window, a
  12.5% fidelity loss, because a longer window collapses more under
  last-write-wins. Fewer applied is not free: it means staler positions on screen.

  A note on the harness, because it nearly measured nothing. The first draft
  consumed the stream in one synchronous `for` loop, so every mutation arrived in
  the same event-loop turn: `PowerBatch` flushed once, the coalescer's window fired
  once, and all three coalescing arms tied at one update each. That is the
  `setImmediate`/608× lesson in `AGENTS.md` reproduced almost verbatim by a harness
  that looked reasonable. Mutations now arrive in per-frame batches with a real
  delay between frames, and `CLAIM_COALESCE_FRAME_MS=0` uses `setImmediate` so the
  loop still turns without charging every arm the same artificial wait.

- **`geoprecision`** — what rounding coordinates actually saves, on two payload
  shapes and both representations. **The finding is in the flat column, and it is
  zero:** a `Float64Array` is 8 bytes per coordinate whatever the value, so
  rounding does not shrink it at all. The saving is entirely on the JSON side, and
  it is shape-dependent — 40.6% on line-heavy data, only 10.8% on point-heavy data.

  So MapLibre's "reduce coordinate precision" advice is worth 40% on a line-heavy
  dataset and 11% on a point-heavy one, and nothing at all once you have flattened.
  The win is representation choice, not a rounding pass.

All three modes are seeded (`makeRng(SEED)`, not `Math.random()` — BENCH-001's
unseeded randomness is a recorded defect) and every parameter is overridable from
the environment.
