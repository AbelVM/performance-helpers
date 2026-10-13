# 0015. Geospatial scope: fill the gaps maplibre-gl-js, turf.js and deck.gl leave

**Status:** Accepted
**Affects:** no shipped code. One new guide (`guides/geo.md`), one new section in
`guides/metaGuide.md`, one new helper option on four existing helpers
(`PowerDeadline`, `PowerCircuit`, `PowerCron`, `PowerEventLoopMonitor` — GEO-039),
and four new `bench/claims.js` modes (`geoencode`, `geocoalesce`, `geoprecision`,
`geoprefetch`).
**Evidence:** `node bench/claims.js geoencode|geocoalesce|geoprecision|geoprefetch`,
run 2026-10-10. All four modes were added for this decision; before they existed
the questions had no answers either way.

## Context

The question was whether `performance-helpers` should grow a geo interface or
helper to reach the geospatial ecosystem — maplibre-gl-js, turf.js, deck.gl and
their neighbours.

The answer is yes, but narrowly, and the narrowness is the decision. This library
does not build geospatial features. It builds the things a geospatial
_application_ needs that those libraries do not provide, so that someone using
them can build a faster app with less work.

**The test every candidate had to pass:** _does this help someone build a
performant app around maplibre / turf / deck.gl, by filling a gap those libraries
leave, without reimplementing anything they own?_

That test did real work. It moved five candidates out of the plan, and it put a
fence around a sixth. Recording it here so the next proposal is measured against
it rather than against enthusiasm.

## What the ecosystem already solved, and what it did not

| Already solved elsewhere                                                         | Not solved, and where we fit                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| turf.js — spatial analysis, 10.4k stars, MIT, modular                            | Moving a coordinate stream from a worker to a renderer without a JSON round-trip         |
| geojson-vt / @maplibre/geojson-vt — on-the-fly tiling                            | Coalescing a high-frequency stream of feature mutations into one bounded diff            |
| supercluster — clustering, embedded in MapLibre                                  | Deciding _when_ to push an update so the main thread is not blocked                      |
| flatbush / kdbush / rbush — spatial indexes, `index.data` already transferable   | Lifecycle and invalidation of a built index across a dataset version change              |
| vt-pbf / @maplibre/vt-pbf — MVT protobuf serialisation                           | Knowing whether a frame budget was met, and whether a long frame was yours or the host's |
| deck.gl — GPU rendering, binary attributes, worker-side attribute generation     | A dependency-free, typed-array-shaped carrier that produces those attributes             |
| PMTiles / FlatGeobuf / tippecanoe / martin / tileserver-rs — formats and servers | A Node-side composition recipe for a geometry pipeline using helpers we already ship     |

The geospatial world does not have a geospatial-_algorithms_ gap. It has a
**data-movement, scheduling and clock** gap, and that is the layer this library
already owns.

## Measurement

Three modes, all added for this decision.

### `geoencode` — when does a flat typed array beat an object graph?

Four arms, same payload, real worker, real call path. 200 LineStrings × 4,500
coordinates (the MapLibre #106 shape) and 200k points:

| payload          | stringify     | arm1 json | arm2 clone | arm3 clone | arm4 xfer | 4 vs 2     |
| ---------------- | ------------- | --------- | ---------- | ---------- | --------- | ---------- |
| 200 lines x 4500 | **196.69 ms** | 296.91    | 393.75     | 1.66       | 8.35      | **47.2x**  |
| 200k points      | 25.17 ms      | 56.95     | 103.96     | 0.64       | 0.45      | **232.4x** |

**The stringify measurement independently confirms MapLibre #106.** The issue
reports _"about 200ms"_ for `JSON.stringify` on exactly this payload shape; this
harness measures **196.69 ms** on the same shape, on a different machine and a
different V8. That the harness reproduces a number reported by someone else is
the strongest available evidence that it models the real call path rather than a
synthetic one.

Three further findings:

1. **Structured clone of the object graph is _slower_ than JSON.** arm2 (393.75
   ms) beats arm1 (296.91 ms) in the wrong direction. So the obvious "just
   `postMessage` the object" answer is _worse_ than what MapLibre already does.
2. **A flat buffer is 47x faster than the object graph** on the #106 shape and
   232x on points. The object-graph penalty dominates by two orders of magnitude.
3. **The win is flattening, not transferring.** arm3 (structured clone of the
   flat buffer, 1.66 ms) is within timer resolution of arm4 (zero-copy transfer,
   ~1.3 ms after subtracting the 7.06 ms build). Chrome's ~46x transfer figure
   does not reproduce at this size, because cloning a _flat_ buffer is already
   cheap.

### `geocoalesce` — does a coalescer beat `PowerBatch` + a `Map`?

2000 entities at 1 Hz for 1 s = 2,000 mutations over 60 frames. `work ms`
subtracts the frame delay, which is charged to every arm equally:

| arm             | work ms | updates | applied |
| --------------- | ------- | ------- | ------- |
| per-mutation    | 37.5    | 2000    | 1,980   |
| PowerBatch      | 4.9     | 60      | 1,980   |
| **Batch + Map** | **3.8** | 60      | 1,961   |
| coalescer 16ms  | 7.7     | 3       | 1,325   |

Window sweep at 1/2/4/16 ms: at every setting the coalescer is at best _equal_ to
`PowerBatch` + a `Map` on work, and it always applies fewer mutations — 1,716
against 1,961 at a 16 ms window, a 12.5% fidelity loss, because a longer window
collapses more under last-write-wins. Fewer applied is not free: it means staler
positions on screen.

**A note on the harness, because it nearly measured nothing.** The first draft
consumed the stream in one synchronous `for` loop, so every mutation arrived in
the same event-loop turn: `PowerBatch` flushed once, the coalescer's window fired
once, and all three coalescing arms tied at one update each. That is the
`setImmediate`/608x lesson in `AGENTS.md` reproduced almost verbatim by a harness
that looked reasonable. Mutations now arrive in per-frame batches with a real
delay between frames.

### `geoprecision` — what does rounding actually save?

Saving against the unrounded payload:

| payload          | repr | 15d   | 6d         | 3d     |
| ---------------- | ---- | ----- | ---------- | ------ |
| 200 lines x 4500 | json | -0.1% | **-40.6%** | -55.6% |
| 200 lines x 4500 | flat | -0.0% | **-0.0%**  | -0.0%  |
| 200k points      | json | -0.0% | **-10.8%** | -14.8% |
| 200k points      | flat | -0.0% | **-0.0%**  | -0.0%  |

**The finding is in the flat column, and it is zero.** A `Float64Array` is 8 bytes
per coordinate whatever the value, so rounding does not shrink it at all. The
saving is entirely on the JSON side, and it is shape-dependent: 40.6% on
line-heavy data, only 10.8% on point-heavy data.

### `geoprefetch` — what in-flight window should a camera prefetch use?

GEO-049's UC4 needs a priority cursor bounded by an in-flight window. MapLibre PR
#8670 measures 12 as optimal against Chromium's ~6 connections per origin and
states the ratio explicitly — but that ratio is host-dependent, so a recipe that
hard-codes it is a claim without a number. The mode sweeps the window against a
simulated per-tile latency and reports requests issued, requests abandoned
mid-flight, and work still outstanding at arrival.

| window | issued | abandoned | outstanding | landed late | waste % |
| -----: | -----: | --------: | ----------: | ----------: | ------: |
|      6 |     30 |         0 |           6 |           0 |     0.0 |
|     12 |     60 |         0 |          12 |           0 |     0.0 |
|     24 |     96 |         0 |           0 |           0 |     0.0 |

**The determinant is lead vs latency, not the window.** With the defaults — 60
frames of read-ahead, 1 002 ms, against 600 ms per tile — the lead covers the
latency, so no tile can land late and none can be abandoned: every window reads
0.0 % waste, and the window controls only how far ahead you read and how much is
still in flight when the camera lands. A window that is too small puts the churn
back; one that is too large holds requests that queue behind the render loop.

Drop the lead below the latency and the waste appears, and **a larger window makes
it worse, not better**: at 2 000 ms per tile over a 10 s flight, windows 6 and 12
both waste 77.8 % and window 24 wastes 87.5 %. The window cannot fix a lead that
is too short — raise the read-ahead first.

**This is a simulation, not a measurement of a real browser.** It cannot discover
the host's connection limit, so the limit is injected and the crossover is
host-dependent even though the shape of the trade-off is not. PR #8670's 23
abandoned at window 6 came from a real browser whose sampled path and actual path
diverge; this model uses one path for both, so it cannot reproduce that term.

## Decision

**One helper change, one guide, and a set of recorded rejections.**

### Adopted

**GEO-039 — an injectable `now` on four helpers.** `PowerDeadline`,
`PowerCircuit`, `PowerCron` and `PowerEventLoopMonitor` read the module clock
directly, so a caller freezing time — MapLibre's `setNow()` / `restoreNow()`, or a
suite's fake timers — got no effect on any of them, and could not inject a clock
into `PowerCircuit` at all. This is not a performance gap, it is an integration
gap, and it is the kind that makes a library feel foreign in an ecosystem.

The scope was corrected during implementation: an earlier revision listed ten
helpers. Reading the source showed six already accept `now` — the four limiters
via `attachLimiterClock`, plus `PowerTTLMap` and `cache/core`, both of which carry
a comment citing PERF-007. The real gap was four. The lesson is the one
`AGENTS.md` records about guessed shapes: _read the code before writing the list._

**`guides/geo.md` plus a metaGuide section.** The highest-ROI deliverable in the
whole analysis, and the only one that is unambiguously positive. It costs no API
surface, cannot regress, and requires no benchmark. It is also the difference
between this library being relevant to the geospatial ecosystem and invisible to
it.

### Rejected, with reasons

| Candidate                                                      | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A columnar binary carrier (`powerGeoColumns`)                  | **The transport already exists.** `powerMessageCodec` ships `CODECS.RAW`, which stores an `ArrayBuffer` or typed array _"verbatim, with no serialization at all"_, plus `isRawPayload()` for realm-independent detection and `collectTransferables()`, which walks an arbitrary object graph and returns every `ArrayBuffer` in it precisely so they can be transferred rather than copied. That is the whole transport half, already hardened against the cross-realm defect class twice (WRK-006, AUD-011). What was left was a struct-of-arrays _column store_ — a data structure, and building geo data structures is what this library said it would not do — and a _declared layout_, which is a convention worth five lines of JSDoc. There is also a consumer problem: MapLibre's `GeoJSONSource` takes GeoJSON or a URL and deck.gl has its own binary attribute layout, so our format would need an adapter on the far side in both cases. |
| A generic time/frame-bounded coalescer (`powerCoalesce`)       | **Measured, and the rejection condition fired.** See the `geocoalesce` table above. `PowerBatch` + a `Map` wins on work and on fidelity, and it is a recipe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A standalone coordinate-precision helper (`powerGeoPrecision`) | **The host owns this feature.** turf.js owns `truncate`. A typed-array variant is a _performance variant of a filled gap_, not a filled gap, and it makes the DX worse: a second truncate to choose between, with different duplicate-collapse and ring re-closing behaviour. `geoprecision` shows why — the saving is 0% on a flat buffer, so the win is representation choice, not a rounding pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A camera-movement prefetch helper (`powerGeoPrefetch`)         | **The host owns this feature.** MapLibre PR #8670 adds `preload: true` to core, sampling the movement's own path and requesting tiles through a priority cursor bounded by an in-flight window. Duplicating that is the definition of "building an owned maplibre feature". The recipe survives, scoped to where core prefetch does not reach: custom sources registered through `addSourceType`, and deck.gl layers. `geoprefetch` measures the recipe's one tunable — the in-flight window — and finds the determinant is read-ahead lead vs per-tile latency, not the window: with the lead covering the latency every window reads 0.0 % waste, and with the lead too short a _larger_ window wastes more, not less.                                                                                                                                                                                                                             |
| A fixed-timestep game-loop helper (`powerFixedStep`)           | **Not a geospatial feature.** It is not a gap maplibre or turf leaves, and it is not one this library is unusually placed to fill: the pattern is ~50 lines with many existing implementations. It may belong on the _general_ roadmap as a scheduling primitive, but it does not belong in a geo proposal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Spatial analysis (distance, area, buffer, intersection)        | turf.js is 10.4k stars, MIT, and modular. `buffer` delegates to JSTS, a large transitive dependency we cannot vendor under the zero-dependency rule (`REJ-008`). No measured premise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A spatial index (R-tree / KD-tree / packed Hilbert)            | flatbush indexes 1M rectangles in 109 ms and kdbush is 5–8x faster than rbush at indexing. We would be reimplementing a solved, benchmarked data structure and losing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Point clustering                                               | supercluster is the reference implementation, is embedded in MapLibre, and clusters 6M points in a browser.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| MVT / PBF encoding                                             | vt-pbf and @maplibre/vt-pbf exist. Protobuf wire-format compliance is a correctness exercise with a published spec, not a performance one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Projection / reprojection math                                 | math.gl, proj4 and MapLibre's internals own this. A subtle correctness surface (antimeridian, pole clipping, non-linear latitude) with **no** measured performance premise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| H3 / S2 / geohash encoding                                     | h3-js and geohash libraries exist. The integer-vs-string tradeoff is documented; the win is in _choosing_ the key shape, not in a faster encoder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A faster GeoJSON parser                                        | `JSON.parse` is native and beats anything writable in JS. The win is in _not parsing_.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A `PowerMap` / map-engine abstraction                          | That is a rendering engine. Out of scope by the library's own definition, and it would make this package a competitor to MapLibre rather than a complement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Payload compression for geo                                    | **Already measured and rejected.** `bench/claims.js payload` exists precisely to settle "why compression does not pay in-process".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A `SharedArrayBuffer` permit pool for geo                      | **Already measured and rejected.** `bench/claims.js permit` takes the same dispatch decision two ways — a plain field read and an `Atomics.load` — and `AGENTS.md` records the atomic at **6.4x more expensive**. The premise was inverted, not merely unproven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Building on `importScriptInWorkers()`                          | Documented as _"using some very internal classes and flows … considered experimental and can break at any point."_ A geo story built on it breaks on a MapLibre minor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Consequences

**The expected yield is one helper change and one guide.** That is a thinner
result than the analysis started with, and it is the honest one. Five candidates
that looked like code turned out to be either performance variants of something
the host already owns, or general library gaps wearing geo clothes.

**The guide is the deliverable that matters.** Every pipeline in `guides/geo.md`
is a composition of shipped helpers plus one or two gaps. Nobody outside this
repository can see that, because the guide did not exist. UC4 — camera-movement
prefetch — prices the cost of that invisibility most concretely: a working, used,
published plugin (`maplibre-preload`) still needed a monkey-patch of four camera
methods, a `Tile` class hijack described by its own author as _"a community
hack"_, a duplicated flight-path implementation that needed its own `zoomTo` bug
fix, and a blocking wait.

**A use case worked end to end is what tests a scope judgement, in both
directions.** UC4 first _rehabilitated_ the prefetch candidate, by showing the
priority policy was far more than "five lines of arithmetic". It then _rejected_
it, once it was clear MapLibre is adding `preload: true` to core. Both conclusions
came from the same use case, and the second only arrived with the scope test
applied deliberately.

## Related

- `guides/geo.md` — the router, and the four use-case pipelines
- `guides/metaGuide.md` — the "Geospatial" section and quick-chooser rows
- ADR 0009 — which clock a helper subtracts
- ADR 0012, 0013 — measured-and-rejected, the pattern this ADR follows
- `bench/claims.js` modes `geoencode`, `geocoalesce`, `geoprecision`, `geoprefetch`
