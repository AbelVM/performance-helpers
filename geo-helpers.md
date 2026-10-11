# geo-helpers — gap analysis, recommendations and implementation plan

**Status:** proposal / analysis. No code has been written.
**Scope question:** _should `performance-helpers` grow a geo interface or helper to reach the
geospatial ecosystem (maplibre-gl-js, turf.js, deck.gl, …)?_
**Consolidated:** 2026-10-10. This revision merges four earlier passes — ecosystem evidence,
an API-to-API match with MapLibre GL JS, four real use cases (the fourth drawn from MapLibre
PR #8670, camera-movement prefetch), and an explicit scope statement — into one document,
removes the material they superseded, and re-scopes the plan from 47 rows to 36.

**Scope, in one line:** we do not build geospatial features. We fill the gaps maplibre-gl-js,
turf.js and deck.gl leave, so that someone using them can build a faster app with less work.
§1.1 states the test every candidate had to pass; two candidates failed it and were moved out
of the plan.

---

## 1. Verdict

**Yes — but narrowly, and not as a geo engine.**

### 1.1 The scope, stated before anything else

This library does not build geospatial features. It builds the things a geospatial
_application_ needs that maplibre-gl-js, turf.js and deck.gl do not provide, so that someone
using those libraries can build a faster app with less work. Concretely:

| We do                                                                                        | We do not                                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Fill a gap those libraries leave — an accumulator where they define a shape but no scheduler | Reimplement a feature they own — `turf.truncate`, supercluster, geojson-vt, MVT encoding |
| Make our own helpers honour the conventions of the ecosystem they sit in                     | Become a competitor to them, or a wrapper around them                                    |
| Ship recipes that make an existing composition discoverable                                  | Ship a helper where a recipe would do                                                    |
| Improve the developer experience of _using_ those libraries                                  | Add API surface that only makes sense if you also use those libraries                    |

**The test every candidate below had to pass:** _does this help someone build a performant app
around maplibre / turf / deck.gl, by filling a gap those libraries leave, without
reimplementing anything they own?_ Two candidates failed it and were moved out of the plan in
this revision — see §1.4.

### 1.2 What the gap actually is

The geospatial world does not have a geospatial-_algorithms_ gap. It has a
**data-movement, scheduling and clock** gap, and that is the layer this library already
owns.

| Already solved elsewhere                                                         | Not solved, and where we fit                                                             |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| turf.js — spatial analysis, 10.4k stars, MIT, modular                            | Moving a coordinate stream from a worker to a renderer without a JSON round-trip         |
| geojson-vt / @maplibre/geojson-vt — on-the-fly tiling                            | Coalescing a high-frequency stream of feature mutations into one bounded diff            |
| supercluster — clustering, embedded in MapLibre                                  | Deciding _when_ to push an update so the main thread is not blocked                      |
| flatbush / kdbush / rbush — spatial indexes, `index.data` already transferable   | Lifecycle and invalidation of a built index across a dataset version change              |
| vt-pbf / @maplibre/vt-pbf — MVT protobuf serialisation                           | Knowing whether a frame budget was met, and whether a long frame was yours or the host's |
| deck.gl — GPU rendering, binary attributes, worker-side attribute generation     | A dependency-free, typed-array-shaped carrier that produces those attributes             |
| PMTiles / FlatGeobuf / tippecanoe / martin / tileserver-rs — formats and servers | A Node-side composition recipe for a geometry pipeline using helpers we already ship     |

### 1.3 The candidates, in priority order

| #   | Candidate                                            | Status                | Why this rank                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **`guides/geo.md` + a metaGuide section**            | Not code              | Unambiguously positive ROI. Costs no API surface, cannot regress, needs no benchmark — and it is the difference between this library being relevant to the ecosystem and invisible to it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | **Injectable clock** (GEO-039)                       | Build                 | A **correctness prerequisite** for two of the four real use cases. A simulator cannot be deterministic without it; a game cannot run a fixed timestep without it. Today neither can be built on this library without hand-threading a clock into ten places.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 3   | **A generic time/frame-bounded coalescer** (GEO-009) | Build if GEO-002 pays | MapLibre has _already specified_ the diff protocol (`GeoJSONSourceDiff` / `GeoJSONFeatureDiff` — public, ordered, id-keyed types) and left exactly one gap: nothing accumulates many small mutations into one diff, bounds that accumulation, or declares a drop policy. **Re-scoped after the §1.1 test:** the capability is general, so the helper is generic and the `GeoJSONSourceDiff` adapter is a 10-line recipe (GEO-020) — emitting their diff type from our public API would couple us to their protocol, which is the "owned maplibre feature" problem in reverse. **The gap is verified, not assumed:** neither `PowerBatch` (`maxSize`/`scheduling`/`onError`) nor `PowerScheduler` (`scheduling`/`onError`/`taskPriority`) has any _time_ bound, so there is no frame-aligned or at-most-every-N-ms flushing anywhere in the library. |
| 4   | **The `geoencode` measurement** (GEO-001) + a recipe | Measure, then recipe  | Not a helper. The transport half of the proposed carrier **already ships**: `CODECS.RAW` stores an `ArrayBuffer` or typed array verbatim with no serialization, and `collectTransferables()` walks an arbitrary object graph and returns every buffer in it so they can all be transferred zero-copy. What was left was a column-store data structure and a layout convention — the first is a geo data structure we should not build, the second is five lines of JSDoc. §4.1.                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | **A precision recipe** (GEO-020)                     | Recipe                | turf owns `truncate`, so a _standalone_ `powerGeoPrecision` fails the §1.1 test — it is a performance variant of a filled gap, not a filled gap, and a second truncate to choose between hurts DX rather than helping it. The recipe shows the 8-line function for a caller who already holds coordinates in a typed array, and points at `turf.truncate` for everyone else. GEO-012 is rejected in §7.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

**Expect one or two of these to survive measurement.** That is the honest expected yield, and a
measured negative is worth more to this project than an unmeasured positive — its changelog
is built on retracted claims and treats them as assets.

### 1.4 Two candidates moved out by the scope test

An earlier revision of this document carried five code candidates. Two fail the test in §1.1
and are recorded here rather than deleted, because the reasoning is worth keeping.

**`powerGeoPrefetch` (GEO-016) — moved to recipe only.** UC4 (§6.5) is camera-movement
prefetch, and MapLibre PR #8670 is adding `preload: true` to core for exactly that. Building a
helper that duplicates a feature the host library is actively adding is the definition of
"building an owned maplibre feature". What survives is the **recipe for where core prefetch
does not reach** — custom sources registered through `addSourceType`, and deck.gl layers,
neither of which core `preload` covers. That is filling a gap, not duplicating a feature.
GEO-048 carries it.

**`powerGeoPrecision` (GEO-012) — folded into the carrier, not shipped standalone.** turf.js owns
`truncate`. A separate helper that rounds coordinates in a typed array is a _performance
variant of a filled gap_ rather than a filled gap, and it makes the DX worse: a developer who
wants to truncate coordinates reaches for `turf.truncate` because that is what everyone uses,
and a second, subtly different truncate — different data shape, different duplicate-collapse
behaviour, different ring re-closing — is a thing to choose between and a migration path if
they switch. Its only justification was callers who already hold a bare `Float64Array`, which
today means callers who already hold coordinates in a typed array. So the capability becomes a
**recipe** (GEO-020): the 8-line function, plus a pointer at `turf.truncate` for everyone else.
GEO-012 is rejected in §7.

**`powerGeoColumns` (GEO-005) — rejected, because the transport already exists.** This was the
candidate with the strongest third-party evidence, and it still fails. Reading
`powerMessageCodec` closely: `CODECS.RAW` stores an `ArrayBuffer` or typed array _"verbatim,
with no serialization at all"_; `isRawPayload()` detects buffers and views realm-independently;
and `collectTransferables(value, maxDepth)` walks an arbitrary object graph and returns every
`ArrayBuffer` it finds, precisely so they can be transferred rather than copied. That is the
entire transport half of the proposed carrier, already shipped and already hardened against the
cross-realm defect class twice over (WRK-006, AUD-011).

What GEO-005 would have added on top is (a) a struct-of-arrays _column store_ — a data
structure, and building geo data structures is the thing this library said it would not do —
and (b) a _declared layout_ so the receiver can interpret the columns, which is a convention
worth about five lines of JSDoc. Neither is a helper.

There is also a consumer problem the first draft never asked about: **what reads the output?**
MapLibre's `GeoJSONSource` takes GeoJSON or a URL, and its worker parses it; deck.gl has its own
binary attribute layout. So a columnar format of ours needs an adapter on the far side in both
cases — more API surface than the problem warrants, for a format in a field that already
contains FlatGeobuf, geobuf, PMTiles and deck.gl's own attributes.

**What survives is the measurement.** GEO-001 asks a question the ecosystem keeps getting wrong
and never answers cleanly — _when does a flat typed array actually beat an object graph across a
`postMessage` boundary, in JS, on the real call path?_ MapLibre #106 records that geobuf was
tried and _"still takes ~200ms (same as before)"_; `web-worker-string-benchmark` measures direct
string transfer beating an ArrayBuffer round-trip by 70–87% at 100 MB because
`TextEncoder`/`TextDecoder` dominates. Running it and publishing the result — including a
negative one — is a genuine contribution, and it is the kind of thing this project's changelog is
built on. It is no longer gated on a helper; it stands on its own.

**`powerFixedStep` (GEO-044) — moved out of the geo plan entirely.** A fixed-timestep loop is
not a geospatial feature, not a gap maplibre or turf leaves, and not something this library is
unusually placed to fill — the pattern is ~50 lines with many existing implementations
(Kontra, published TypeScript loops, every game engine). It may well belong on the _general_
roadmap as a scheduling primitive, but it does not belong in a geo proposal, and including it
was scope creep on my part. GEO-044 is rejected in §7 with that reason.

The general lesson, which is the same one §6.6 records from the other direction: **a use case
worked end to end is what tests a scope judgement, and both of these only became obvious once
UC4 was worked through.**

Everything else on the wishlist is either **already composable from shipped helpers** (the
deliverable is a recipe, not code) or **already solved better elsewhere** (the deliverable
is a recorded rejection with its reason). §7 lists eleven of the latter.

---

## 2. Method, and what is evidence versus what is opinion

This section exists because the distinction matters more than the conclusions.

**What was done.** Read the repository: `AGENTS.md`, `README.md`, `guides/metaGuide.md`,
`src/index.js`, the JSDoc header of every helper in `src/helpers/`, `src/utils/now.js`,
`src/utils/limiterClock.js`, `bench/claims.js`, `scripts/verify.mjs`, `package.json`,
`adr/0001`–`0014`, and the test layout. Read the MapLibre GL JS v6 API reference and source
directly for the extension points in §5. Web research across MapLibre issues and guides,
deck.gl, turf.js, geojson-vt, supercluster, flatbush / kdbush / rbush, FlatGeobuf, geobuf,
vt-pbf, PMTiles, tileserver-rs, H3 / S2 / geohash, GDAL RFC 99, RFC 7946, the W3C Frame
Timing spec, the fixed-timestep literature, and a 2025 peer-reviewed comparative study of
Leaflet / OpenLayers / Mapbox GL JS / MapLibre GL JS.

**What is _not_ evidence.** Nothing here has been measured by us. Every number is either

- **(E)** published by a third party, attributed to its source;
- **(R)** reported by a user in a public issue, attributed to the issue; or
- **(O)** opinion or inference, marked as such.

The project's own rule — _"Measure the premise before building the feature. Four items in
this project's own history were scoped to a number nobody had produced. All four were
wrong, in both directions"_ — is why Phase 0 of the plan is entirely measurement and
contains no implementation. If GEO-001 or GEO-002 comes back negative, the corresponding
candidate is deleted, not shipped with a caveat.

**Where this file lives.** `AGENTS.md` records that _"Working notes do not get their own
root directory — a `design/` folder existed for one 32 KB note and was folded into ADR
0003."_ This file is a working analysis at the path requested. When the decisions in it are
made, the decision record belongs in `adr/0015-*.md` (GEO-024) and the reference material in
`guides/geo.md` (GEO-014); this file should then be deleted or reduced to a pointer
(GEO-025), not left as a second, competing source of truth.

---

## 3. The ecosystem evidence

The numbers that shape the recommendation. Read them as _the premise we would be building
on_, not as our own results.

### 3.1 The serialisation wall

MapLibre GL JS issue [#106](https://github.com/maplibre/maplibre-gl-js/issues/106),
_"GeoJSON Source `setData` can take surprisingly long"_ **(R)**:

> "we generate a GeoJSON with about 200 LineString features with about 4500 geometry
> coordinates each. Because of a design issue in our software, we use `setData` about 5
> times per second. The `JSON.stringify` for said data will take about 200ms each time. …
> At 5 updates per second, it's impossible for the worker to catch up, and the main thread
> blocks forever."

The accepted workaround in the same thread is _"throttled the updates to the GeoJSON source
using `requestAnimationFrame`"_ — the ecosystem's answer to this problem is hand-rolled
coalescing. That is the gap. The same thread also records that geobuf was tried and
_"still takes ~200ms (same as before)"_ — a direct warning that "use a binary format" is
not automatically an answer.

### 3.2 The return path is worse than the outbound path

MapLibre issue
[#6667](https://github.com/maplibre/maplibre-gl-js/issues/6667) **(R)**: on a diff update,
_"the worker thread processes the incremental changes efficiently, but the entire GeoJSON
dataset is sent back to the main thread as part of the response."_ A comment in the same
thread cites a 2024 article for _"~600-1000ms to transfer 500MB between threads"_ — treat
that as a claim in an issue comment, not a measurement. The structural point stands and is
confirmed by the source: the full dataset is returned because `Map#getStyle()` has
undocumented behaviour of inlining loaded GeoJSON, and `serialize()` is synchronous.

### 3.3 Binary encodings are categorically better, not marginally

FlatGeobuf's published benchmark, 906,602 OSM LineStrings for Denmark, relative to
Shapefile = 1 **(E)**:

| Operation              | Shapefile | GeoPackage | **FlatGeobuf** | **GeoJSON** | GML |
| ---------------------- | --------- | ---------- | -------------- | ----------- | --- |
| Read full dataset      | 1         | 1.02       | **0.46**       | **15**      | 8.9 |
| Read w/ spatial filter | 1         | 0.94       | **0.71**       | **705**     | 399 |
| Write full dataset     | 1         | 0.77       | **0.39**       | **3.9**     | 3.2 |
| Size                   | 1         | 0.72       | **0.77**       | **1.2**     | 2.1 |

GeoJSON is **15× slower to read than a Shapefile and 705× slower with a spatial filter**,
while FlatGeobuf is _faster_ than Shapefile on both. This is the strongest available
argument for a columnar carrier — and an argument about _format_, which a JS helper is not.
GEO-001 must therefore measure the JS-specific costs rather than assume the ratio transfers.

### 3.4 The counter-evidence: "just use binary" is sometimes wrong

Two published results cut the other way, and both belong in the measurement design.

**(a) TextEncoder/TextDecoder can dominate a zero-copy transfer.**
`mlightcad/web-worker-string-benchmark` **(E)**, 100 MB:

| Payload | Direct string | ArrayBuffer round-trip | Winner           |
| ------- | ------------- | ---------------------- | ---------------- |
| ASCII   | 211.33 ms     | 692.54 ms              | Direct, by 69.5% |
| Unicode | 202.35 ms     | 1529.89 ms             | Direct, by 86.8% |

Its conclusion is explicit: _"Overhead from TextEncoder / TextDecoder dominates, despite
zero-copy transfer."_

**(b) Structured clone of a flat buffer is already near-free.** Chrome's transferable-objects
post **(E)** measured a 32 MB `ArrayBuffer` round trip at **302 ms by structured clone
versus 6.6 ms by transfer** — ~46×. MDN documents the mechanism: transfer is O(1) in buffer
size because it moves a pointer, not bytes.

**The synthesis (O):** the win is not "binary beats text". The win is **"a flat typed array
beats an object graph"**. A GeoJSON `FeatureCollection` is a deep object graph — arrays of
arrays of arrays of numbers, plus a `properties` object per feature — and structured-cloning
_that_ is what costs. A `Float64Array` of interleaved lon/lat is one allocation. GEO-001
must therefore measure **four arms**, not two:

1. `JSON.stringify` → transfer string → `JSON.parse` (what MapLibre does today)
2. structured clone of the parsed object graph
3. structured clone of a flat `Float64Array` / interleaved column store
4. transfer of that same flat buffer (zero-copy)

Arm 4 versus arm 2 is the number the ecosystem keeps guessing at. Arm 1 versus arm 4 is the
number that decides whether a _recipe_ is worth writing at all — and GEO-005, the helper that
was going to be gated on it, is now rejected (§1.4), so the measurement stands on its own.

### 3.5 deck.gl has already told us where its time goes

From the deck.gl performance guide **(E)**:

> "99% of the CPU time that deck.gl spends in updating buffers is calling the accessors you
> supply to the layer."

> "When the `data` prop changes, the layer will recalculate all of its GPU buffers. … This
> step is the most expensive operation that a layer does — also on CPU. It may take multiple
> seconds for multi-million item layers, and if your `data` prop is updated frequently (e.g.
> animations), 'stutter' can be visible even for layers with just a few thousand items."

> "Some deck.gl applications use web workers to load data and generate attributes to get the
> processing off the main thread. Modern worker implementations allow ownership of typed
> arrays to be transferred directly between threads at virtually no cost, bypassing
> serialization and deserialization of JSON objects."

deck.gl's own remedy for chunked loading is _"one layer per chunk, each with a consistent &
unique id"_ — again a scheduling pattern the application must implement by hand. Its remedy
for a few rows changing in a large table is `updateTriggers`, a _diff_ concept expressed as a
prop.

Its aggregation-layers page also gives a clean measured illustration of why "measure the
premise" matters **(E)** — CPU versus GPU aggregation on random data:

| #objects | CPU iters/sec | GPU iters/sec | Note                  |
| -------- | ------------- | ------------- | --------------------- |
| 25K      | 535           | 359           | GPU is 33% **slower** |
| 100K     | 119           | 437           | GPU is 267% faster    |
| 1M       | 12.7          | 158           | GPU is 1144% faster   |

The crossover is between 25K and 100K objects. Any geo helper touching aggregation must
state its crossover, or it is a claim without a number.

### 3.6 MapLibre's own large-data guide is a list of things the application must do

The MapLibre _"Optimising MapLibre Performance"_ guide **(E)** recommends, in order: remove
unused properties; reduce coordinate precision to ~6 decimals; simplify geometry; minify;
split into chunks; store GeoJSON at a URL rather than inline; cluster; set `maxzoom` on the
source to ~12 for point data; raise the layer's `minzoom`; disable symbol collision checking.
Every one is an application-level transformation with no helper behind it. The Mapbox
equivalent **(E)** gives the concrete number: a heatmap dataset went from **19.3 MB to
3.3 MB** after `geojson-pick` and `geojson-precision` — an 83% reduction, with _"the map
rendering is noticeably quicker and smoother"_.

### 3.7 Coordinate precision is a documented, quantified trade-off

RFC 7946 **(E)**: _"A GeoJSON text containing many detailed Polygons can be inflated almost
by a factor of two by increasing coordinate precision from 6 to 15 decimal places. … 6
decimal places … amounts to about 10 centimeters, a precision well within that of current
GPS systems."_ GDAL RFC 99 **(E)** adds the binary angle: for IEEE-754 doubles, _"at least
the last 16 least-significant bits … of a coordinate can be set to zero while keeping a 1 mm
precision"_, reducing a test zipped GeoPackage from 766 MB to 667 MB (13%).
`perrygeo/geojson-precision` **(E)** reports _"going from 15 to 6 decimal places can reduce
the file size by roughly 50%"_ for large collections. Practical scale at the equator **(E)**:
6 decimals ≈ 11 cm, 5 ≈ 1.1 m, 4 ≈ 11 m, 3 ≈ 110 m.

### 3.8 Spatial indexes are already fast, and already transferable

flatbush, Node 24 on an M1 Pro **(E)**: index 1,000,000 rectangles in **109 ms**; 100
searches at 10% area in 64 ms; 10,000 searches of 1 neighbour in 30 ms. Against rbush on
older Node **(E)**: indexing 1M rectangles 263 ms vs 1208 ms. kdbush indexes 5–8× faster
than rbush and uses ~2× less memory than flatbush for points.

Critically, both expose `index.data` as a single `ArrayBuffer` _specifically so it can be
transferred between threads_ — `postMessage(index.data, [index.data])` then
`Flatbush.from(e.data)`. The hard part (a packed Hilbert R-tree) is done, it is fast, and its
output is already in the shape our codec would carry.

### 3.9 Realtime geospatial feeds have their own failure modes

aisstream.io **(E)**: _"If you do not consume messages quickly enough and sufficient
buffered messages accumulate, the service drops messages"_, with the advice to _"use focused
geographic and message-type filters, and negotiate permessage-deflate compression in your
WebSocket client to avoid dropped events."_ AISHub **(E)** rate-limits to one call per
minute.

**Reading (O):** the failure mode is _unbounded client-side buffering followed by silent
loss_. That is exactly what `PowerRealtimeHub`'s per-subscriber bounded queues and declared
drop policy exist to make visible, and what `PowerDeduplication`, `PowerSequencer` and
`PowerTTLMap` address at the record level. No new helper is needed — but nobody outside this
repository knows that.

### 3.10 The comparative study, for calibration

ICA-ABS 10-14-2025 **(E)**, testing Leaflet, OpenLayers, Mapbox GL JS and MapLibre GL JS at
the end of 2024: Mapbox GL JS is generally 70–200 ms faster than MapLibre for up to 5,000
features; _"MapLibre GL JS is significantly slower than all other libraries for both lines
and polygons, in all scenarios"_ and _"from 50k points onwards it joins Leaflet as the
slowest"_, taking roughly twice the time of the other two.

**Honest reading (O):** this is a study of _renderers_, and it is why a performance-helpers
geo story must not be framed as "make MapLibre faster". We cannot. What we can do is reduce
the work the application hands to it — which is what §§3.1, 3.3 and 3.6 describe.

---

## 4. Gap analysis

Ten gaps were identified. §5 tests them against MapLibre's actual API and §6 against four
real workloads; where those sections supersede a verdict below, the verdict has been
corrected rather than left stale.

| #      | Gap                                                       | Evidence                                                                                           | What already exists here                                                                             | Verdict                                             |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| GAP-1  | No columnar binary carrier for coordinate streams         | §3.1, §3.3, §3.4, §3.5                                                                             | `powerMessageCodec` `CODECS.JSON` / `CODECS.RAW` — the _transport_ is solved; the _producer_ is not  | **BUILD if GEO-001 pays**                           |
| GAP-2  | No coalescing scheduler for high-frequency source updates | §3.1, MapLibre #4364, #7336, #5992                                                                 | `PowerBatch`, `PowerScheduler`, `PowerRealtimeHub` bounded queues + drop policy                      | **BUILD if GEO-002 pays** — prior raised by §5 (F1) |
| GAP-3  | No typed-array coordinate precision pass                  | §3.6, §3.7                                                                                         | Nothing. `turf.truncate` is object-shaped and allocates                                              | **BUILD**                                           |
| GAP-4  | No spatial-index lifecycle helper                         | §3.8                                                                                               | `PowerCache` + `RAW` codec + `PowerPool` compose it                                                  | **RECIPE** — ➖ GEO-017                             |
| GAP-5  | No viewport-priority tile scheduler                       | deck.gl release notes; `setWorkerCount` default 1                                                  | `PowerPriorityQueue` + `PowerSemaphore` + `PowerBulkhead`                                            | **RECIPE** — ➖ GEO-016                             |
| GAP-6  | No stale-record expiry for realtime feeds                 | §3.9                                                                                               | `PowerTTLMap`, `PowerDeduplication`, `PowerSequencer`, `PowerHeartbeat`, `PowerRealtimeHub`          | **RECIPE** — discovery problem, not a code problem  |
| GAP-7  | No frame-budget observability tuned for maps              | MapLibre's hand-rolled FPS example; deck.gl "stutter"                                              | `PowerApdex`, `PowerEventLoopMonitor`, `PowerHistogram`                                              | **RECIPE** — see below                              |
| GAP-8  | No Node-side geometry pipeline composition                | tileserver-rs 1,355 req/s PMTiles vs 759 MBTiles                                                   | `PowerPool`, `PowerChunker`, `PowerCache`, `PowerQueue`, `PowerRetry`/`PowerCircuit`/`PowerDeadline` | **RECIPE** — the clearest case in the analysis      |
| GAP-9  | No memory-pressure-aware degradation                      | deck.gl: phones _"considerably more sensitive to memory pressure … resulting in browser restarts"_ | `PowerBrownout` + `getResourcePressure()`                                                            | **RECIPE**                                          |
| GAP-10 | No grid-key shaping for caches                            | H3: integer indexes _"more performant than string operations"_                                     | `PowerCache` accepts any key, including `BigInt`                                                     | **RECIPE** — three lines in an example              |

### 4.1 GAP-1 — why the carrier is rejected, and what already covers it

**Missing.** A way to move a large coordinate stream across a `postMessage` boundary as one
flat typed array with a declared layout, instead of as a GeoJSON object graph.

**Evidence.** §3.1 (200 ms per `setData`, main thread blocks), §3.3 (FlatGeobuf 15× / 705×),
§3.4 (structured clone of a flat buffer is ~46× cheaper than of a copied buffer), §3.5
(deck.gl explicitly recommends worker-generated binary attributes transferred zero-copy).

**What already exists here — and it is more than the first draft credited.**

- `CODECS.RAW` — _"the value is already an `ArrayBuffer` or typed array and is stored verbatim,
  with no serialization at all."_ The transport is not merely solved, it is shipped, documented
  and frozen.
- `isRawPayload(value)` — realm-independent detection of buffers and views, using
  `isArrayBuffer()` and `ArrayBuffer.isView`. Hardened after WRK-006, where a bare cross-realm
  `ArrayBuffer` was silently `JSON.stringify`'d into `{}` and _decoded successfully_ with the
  payload gone and no error anywhere.
- `collectTransferables(value, maxDepth = 8)` — walks an arbitrary object graph and returns
  every `ArrayBuffer` it finds, precisely so they can be transferred rather than copied.
  Hardened after AUD-011, where a cross-realm buffer was silently _copied_ on the one path
  whose entire job is finding buffers to transfer.

So the transport half of the proposed carrier is done, and it has been hardened against exactly
the defect class `AGENTS.md` warns about — twice.

**What was left, and why neither part is a helper.**

1. **A struct-of-arrays column store** — a container with typed-array fields and accessors.
   That is a _data structure_, and building geo data structures is the thing this library said
   it would not do. The application owns its columns because the application owns its data.
2. **A declared layout** — a schema so the receiver can interpret the columns. That is a
   _convention_, worth about five lines of JSDoc and a typedef, not an export.

**And a consumer problem the first draft never asked: what reads the output?** MapLibre's
`GeoJSONSource` takes GeoJSON or a URL, and its worker parses it. deck.gl has its own binary
attribute layout. So a columnar format of ours needs an adapter on the far side in _both_
cases — more API surface than the problem warrants, in a field that already contains
FlatGeobuf, geobuf, PMTiles and deck.gl's own attributes.

**Verdict: REJECT as a helper.** The measurement (GEO-001) survives, ungated, because it
answers a question the ecosystem keeps guessing at. The recipe (GEO-020) shows how to move
columnar data with what already ships. GEO-005 is rejected in §7.

### 4.2 GAP-3 — why this one is rejected rather than fenced

Rounding can create consecutive duplicate positions; collapsing them can remove a polygon
ring's closing point, which must then be re-closed or the ring is invalid. geojsonkit
documents exactly this ordering (round → collapse → re-close). This is a characterisation
test, not an aspiration.

**Why it fails the §1.1 test.** turf.js owns `truncate`. A standalone helper that rounds
coordinates in a typed array is a _performance variant of a filled gap_, not a filled gap, and
the distinction matters for three reasons:

1. **It makes the DX worse, not better.** A developer who wants to truncate coordinates reaches
   for `turf.truncate`, because that is what everyone uses and what every tutorial shows. A
   second truncate — different data shape, different duplicate-collapse behaviour, different
   ring re-closing — is a thing to choose between and a migration path if they switch. The
   library's job here is to make the _existing_ answer easier to reach, not to compete with it.
2. **Its only justification was contingent.** The caller who holds a bare `Float64Array` is, in
   practice, a caller who already holds coordinates in a typed array — which, since GEO-005 is
   rejected, means a caller who built their own columns. That is a small audience.
3. **The work is rarely on a browser hot path.** RFC 7946's 6-decimal recommendation and
   MapLibre's "reduce precision" advice are normally applied server-side or at build time
   (`geojson-precision`, tippecanoe), where a one-off pass costs nothing.

**What survives.** A **recipe** (GEO-020): the 8-line function for a caller who already holds
coordinates in a typed array, and a pointer at `turf.truncate` for everyone else. No helper, no
second export, no competing truncate. GEO-012 is rejected in §7 with this reasoning.

### 4.3 GAP-7 — why the recipe is `PowerApdex`, not `PowerHistogram`

The attribution half is already solved by `PowerEventLoopMonitor` (_"Tell whether a latency
regression is yours or the host's"_). The frame-time half looks like `PowerHistogram` with a
16.7 ms threshold — except that ADR-0014 records `PowerHistogram.countAtOrBelow()` as
**unsound at the threshold**, which is exactly the number a frame budget cares about. So the
sound instrument is `PowerApdex` with `target = 16.7`, and a dedicated helper would be
solving a problem `PowerApdex` already solves. The conclusion is recorded in GEO-045.

---

## 5. The match with maplibre-gl-js, API to API

An earlier pass analysed MapLibre's _problems_ without analysing its _API_. That was the
wrong way round: "what could we fill" only has an answer relative to the extension points
MapLibre actually exposes. This section lists those extension points with their exact
signatures, maps each onto our actual API, and states the verdict.

### 5.1 MapLibre's extension points, with exact signatures

All signatures quoted from the MapLibre GL JS v6 API reference.

**Resource loading — main thread**

```ts
addProtocol(customProtocol: string, loadFn: AddProtocolAction): void

type AddProtocolAction = (
  requestParameters: RequestParameters,
  abortController: AbortController
) => Promise<GetResourceResponse<AddProtocolResponseData>>
```

Docs: _"This will happen in the main thread, and workers might call it if they don't know
how to handle the protocol."_ A tile is an `ArrayBuffer`; an image is either its encoded
bytes or an `ImageBitmap`/`HTMLImageElement`, used without decoding.

**Custom source types**

```ts
addSourceType(name: string, SourceType: SourceClass): Promise<void>
```

plus the worker-side registration `self.registerWorkerSource(name, WorkerSourceConstructor)`.

**The GeoJSON worker source — the deepest hook MapLibre offers**

```ts
new GeoJSONWorkerSource(actor, layerIndex, availableImages, createGeoJSONIndexFunc?)
```

The fourth parameter is injectable, and the class JSDoc says it is _"designed to be easily
reused to support custom source types for data formats that can be parsed/converted into an
in-memory GeoJSON representation."_ Its options:

```ts
type GeoJSONWorkerOptions = {
  source?: string;
  geojsonVtOptions?: GeoJSONVTOptions;
  clusterProperties?: Record<string, [unknown, unknown]>;
  filter?: FilterSpecification;
  collectResourceTiming?: boolean;
};
type LoadGeoJSONParameters = GeoJSONWorkerOptions & {
  type: 'geojson';
  source: string;
  request?: RequestParameters;
  data?: GeoJSON.GeoJSON;
  dataDiff?: GeoJSONSourceDiff;
  updateCluster?: boolean;
};
```

**Worker pool sizing and lifecycle**

```ts
setWorkerCount(count: number): void   // default 1; Safari: half the CPU cores, capped at 3
getWorkerCount(): number
setWorkerUrl(url: string): void
prewarm(): void                       // create shared workers ahead of time; survive last Map removal
clearPrewarmedResources(): void
importScriptInWorkers(workerUrl: string): Promise<void>   // EXPERIMENTAL
```

`importScriptInWorkers` is documented as _"using some very internal classes and flows …
considered experimental and can break at any point."_ It is implemented as
`getGlobalDispatcher().broadcast(MessageType.importScript, workerUrl)`.

**Image concurrency**

```ts
setMaxParallelImageRequests(numRequests: number): void   // default 16
```

Docs: _"the maximum number of images (raster tiles, sprites, icons) to load in parallel,
which affects performance in raster-heavy maps."_ **Images only** — see F3.

**Message fan-out**

```ts
interface Dispatcher {
  broadcast<T extends MessageType>(type: T, data: RequestResponseMessageMap[T][0])
    : Promise<RequestResponseMessageMap[T][1][]>;
  getActor(): Actor;   // "The actors are distributed in round-robin fashion."
}
getGlobalDispatcher(): Dispatcher
```

**The data path**

```ts
GeoJSONSource.setData(data: string | GeoJSON): Promise<void>
GeoJSONSource.updateData(diff: GeoJSONSourceDiff): Promise<void>
GeoJSONSource.getData(): Promise<GeoJSON>
GeoJSONSource.getBounds(): Promise<LngLatBounds>
GeoJSONSource.serialize(): GeoJSONSourceSpecification
GeoJSONSource.setClusterOptions(options: SetClusterOptions): Promise<void>
GeoJSONSource.getClusterLeaves(clusterId: number, limit: number, offset: number): Promise<Feature[]>
GeoJSONSource.onRemove(): void
```

`onRemove()` is documented as: _"Drops the worker updates waiting to be sent, which would
otherwise rebuild the worker's state for a source that is gone. The update being sent ends
in a `dataabort` event."_ MapLibre itself acknowledges the queued-update problem and solves
it by dropping — silently.

**The diff protocol — already fully specified by MapLibre**

```ts
type GeoJSONSourceDiff = {
  removeAll?: boolean; // processed first
  remove?: GeoJSONFeatureId[];
  add?: GeoJSON.Feature[];
  update?: GeoJSONFeatureDiff[]; // processed last
};

type GeoJSONFeatureDiff = {
  id: GeoJSONFeatureId;
  newGeometry?: GeoJSON.Geometry; // processed first
  removeAllProperties?: boolean;
  removeProperties?: string[];
  addOrUpdateProperties?: { key: string; value: any }[];
};
```

Both carry an explicit processing order in their JSDoc. This is a complete, ordered,
id-keyed diff protocol with a public type.

**Time control**

```ts
now(): number;  setNow(t: number): void;  isTimeFrozen(): boolean;  restoreNow(): void
```

**Frame and lifecycle events** — `render`, `idle`, `sourcedata`, `dataloading`, `data`,
`styledata`, `load`, `error`, `webglcontextlost`, `webglcontextrestored`,
`styleimagemissing`, `terrain`, `projectiontransition`.

**Restyle without re-feeding** — `map.setFeatureState(feature, state)`,
`map.removeFeatureState(...)`.

**Rendering** — `CustomLayerInterface` (`onAdd`, `onRemove`, `render`), and
`MapLibreOverlay` from `@deck.gl/maplibre`, which _"renders deck.gl layers using MapLibre's
public APIs"_ and in interleaved mode _"inserts deck.gl layers into the MapLibre style and
shares its WebGL2 context."_

**v6 constraints that shape any integration** — ESM-only distribution
(`maplibre-gl.mjs`); WebGL2 now required (`GPUInitializationError` thrown otherwise);
`setWorkerUrl()` still required per-bundler; `zoomLevelsToOverscale` default changed to 4;
`styleimagemissing` listeners can no longer call `addImage` (use
`setMissingStyleImageResolver`); GeoJSON nested objects now encode as `__$json__`.

### 5.2 The match table

| MapLibre extension point                                                                                                                                                                                                 | Our helper(s)                                                                                                                                                                                                                                                                                                  | Verdict                                     | What is actually missing                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addProtocol` — custom resource loading                                                                                                                                                                                  | `PowerWebSocketClient`, `PowerSocketAdapter`, `PowerSseAdapter`, `PowerMessagePort`, `PowerRTCChannel`, `PowerDatagramChannel`, `PowerWebTransportClient`, `PowerRetry`, `PowerRetryBudget`, `PowerCircuit`, `PowerDeadline`, `PowerSemaphore`, `PowerBulkhead`, `PowerHistogram`, `PowerApdex`, `PowerLogger` | **Strong match — RECIPE**                   | Nothing. MapLibre's `makeRequest` has no retry, no circuit breaker, no deadline and no per-protocol telemetry. Every one of those is a shipped helper. The `AbortController` MapLibre hands the `loadFn` maps onto the `AbortSignal` our helpers already accept.                                                                                         |
| `GeoJSONSource.setData` / `updateData`                                                                                                                                                                                   | `PowerBatch`, `PowerScheduler`, `PowerRealtimeHub`, `PowerDeduplication`, `PowerTTLMap`                                                                                                                                                                                                                        | **Strong match — BUILD (GEO-009)**          | The scheduler. MapLibre specifies the diff _shape_ completely (§5.1) but supplies no way to accumulate many small mutations into one diff, no bound on that accumulation, and no declared drop policy. See F1.                                                                                                                                           |
| `GeoJSONWorkerSource` + injectable `createGeoJSONIndex`                                                                                                                                                                  | `PowerChunker`, `PowerCache`, `PowerPool`                                                                                                                                                                                                                                                                      | **Match — RECIPE**                          | Nothing algorithmic. What is missing is the _decision rule_: `GeoJSONVTOptions.updateable` carries a documented caveat ("with caveat of a stored simplified copy"), and MapLibre #7336 shows the incremental index update is a **loss** when all features are touched. The guide must state when to use `updateData` and when to fall back to `setData`. |
| `setWorkerCount` / `prewarm` / `setWorkerUrl`                                                                                                                                                                            | `PowerPool`                                                                                                                                                                                                                                                                                                    | **Complementary, not overlapping — RECIPE** | Nothing. But a trap: `setWorkerCount` must be called **before** any map is created and `prewarm()` must come **after** `setWorkerUrl`/`setWorkerCount`. Get the order wrong and the map silently runs on one worker.                                                                                                                                     |
| `setMaxParallelImageRequests` (default 16)                                                                                                                                                                               | `PowerSemaphore`, `PowerBulkhead`, `PowerThrottle`, `PowerGCRA`                                                                                                                                                                                                                                                | **Partial match — RECIPE**                  | MapLibre bounds **image** parallelism only. There is no exposed bound on vector-tile requests or GeoJSON worker messages. See F3.                                                                                                                                                                                                                        |
| `Dispatcher.broadcast` / `getActor`                                                                                                                                                                                      | `PowerRealtimeHub`, `PowerEventBus`, `PowerBroadcastBus`                                                                                                                                                                                                                                                       | **Complementary — RECIPE**                  | Nothing. Note the asymmetry: MapLibre's `broadcast` is unbounded and all-or-nothing (correct for tiles, where correctness matters); our hub is bounded with a declared drop policy (correct for telemetry). Do not "improve" MapLibre's fan-out.                                                                                                         |
| `map.on('render'`, `'idle'`, `'sourcedata'`, `'dataloading'`, `'data'`, `'styledata'`, `'load'`, `'error'`, `'webglcontextlost'`, `'webglcontextrestored'`, `'styleimagemissing'`, `'terrain'`, `'projectiontransition'` | `PowerObserver`, `PowerEventBus`, `PowerApdex`, `PowerEventLoopMonitor`, `PowerHistogram`                                                                                                                                                                                                                      | **Strong match — RECIPE**                   | Nothing. MapLibre's own _"Display Map Performance Metrics"_ example hand-rolls an FPS counter with `performance.now()`; `PowerApdex {target: 16.7}` plus `PowerEventLoopMonitor` replaces it and adds host-vs-app attribution. `PowerObserver.getServerSnapshot()` covers the SSR case that v6's ESM-only distribution makes more common.                |
| `map.setFeatureState` / `removeFeatureState`                                                                                                                                                                             | `PowerObserver`, `PowerTTLMap`                                                                                                                                                                                                                                                                                 | **Match — RECIPE**                          | Nothing. MapLibre's own Flutter docs state the rule: _"For restyling rather than reshaping data, prefer feature state over re-feeding the source: changing one feature's color by re-sending the whole collection re-encodes and re-tessellates everything."_ Same lesson as deck.gl's `updateTriggers`.                                                 |
| `now()` / `setNow()` / `isTimeFrozen()` / `restoreNow()`                                                                                                                                                                 | `PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerRateLimit`, `PowerCircuit`, `PowerTTLMap`, `PowerDeadline`, `PowerCron`, `PowerHeartbeat`, `PowerEventLoopMonitor`                                                                                                                                   | **Mismatch — BUILD (GEO-039)**              | See F2. This is the one place where our API and MapLibre's genuinely fail to meet.                                                                                                                                                                                                                                                                       |
| `CustomLayerInterface` / `MapLibreOverlay`                                                                                                                                                                               | `PowerBuffer`, `powerMessageCodec` `RAW`                                                                                                                                                                                                                                                                       | **Match — RECIPE**                          | Nothing. Binary attribute buffers produced by a worker feed either path — `RAW` already moves them verbatim and `collectTransferables()` already finds them.                                                                                                                                                                                             |
| `map.pause()` / `resume()` / `triggerRepaint()`                                                                                                                                                                          | `PowerBrownout`, `getResourcePressure()`, `PowerScheduler`                                                                                                                                                                                                                                                     | **Match — RECIPE**                          | Nothing. Pausing an off-screen map is the browser form of shedding optional work.                                                                                                                                                                                                                                                                        |
| `importScriptInWorkers`                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                                                                              | **Do not use**                              | Documented experimental, _"can break at any point"_. Building on it means our geo story breaks on a MapLibre minor. Use `addProtocol` + `addSourceType` instead, which are stable.                                                                                                                                                                       |

### 5.3 Three findings

**F1 — MapLibre already specifies the diff protocol; we would only be supplying the
scheduler. This raises confidence in GEO-009.**

`GeoJSONSourceDiff` and `GeoJSONFeatureDiff` are **public, versioned, ordered types** with
documented processing order. A coalescer that emits them is not inventing a protocol — it is
filling the one gap in an existing one.

What MapLibre does not have, and what §3.1 says applications hand-roll:

- accumulation of many small mutations into one diff (the accepted workaround in #106 is a
  manual `requestAnimationFrame` throttle with an in-memory cache of pending changes);
- a bound on that accumulation, so a slow consumer cannot grow it without limit;
- a declared policy for what is discarded when the bound is reached — MapLibre's own answer
  in `onRemove()` is to drop queued updates and fire `dataabort`, i.e. silently;
- alignment of the flush to the frame clock (`map.on('render')`), so a diff lands once per
  frame rather than once per mutation.

`PowerRealtimeHub` already has bounded per-subscriber queues with `drop-oldest` /
`drop-newest` / `disconnect`, and `PowerBatch` already coalesces. The missing piece is
narrow: **a coalescer whose output type is `GeoJSONSourceDiff` and whose flush clock is
injectable** (`requestAnimationFrame` in a browser, `PowerScheduler`'s one-flush-per-turn in
Node).

It also sharpens GEO-002: the benchmark must measure **diff quality**, not just latency —
how many mutations were coalesced, how many were dropped, and whether the drop policy was
the declared one. A coalescer that wins on throughput by silently discarding half the
mutations has not won, and MapLibre's `dataabort` event is the observable that tells you.

**F2 — MapLibre's time-freezing API cannot drive most of our clock-driven helpers.**

MapLibre exposes `now()`, `setNow()`, `isTimeFrozen()` and `restoreNow()` so an application
can freeze time and get deterministic rendering and deterministic tests. Our clock-driven
helpers read a module-level clock resolved at import time.

**Corrected after reading the source.** An earlier revision of this section listed ten helpers
as having no injection point. That was wrong, and the error was in _not reading the code
before writing the list_ — the same failure mode as the guessed message payloads and guessed
`drain()` return values recorded in `AGENTS.md`. The actual position:

**Already injectable — six helpers, no work needed:**

- `PowerThrottle`, `PowerGCRA`, `PowerSlidingWindow`, `PowerRateLimit` — via
  `attachLimiterClock` / `resolveLimiterNow` (`src/utils/limiterClock.js`), where an
  explicitly injected clock always wins.
- `PowerTTLMap` — `this._now = typeof opts?.now === 'function' ? opts.now : nowMs`, with a
  comment saying _"Injected clock, matching the limiters (PERF-007). Without it, testing
  expiry means a real `setTimeout`, and a real `setTimeout` is a flake."_
- `cache/core` — `this._now = typeof now === 'function' ? now : nowMs`, with a comment saying
  _"matching the limiters (PERF-007) and `PowerTTLMap`"_ and noting it is read at seven sites.

**Genuinely missing — four helpers:**

- `PowerDeadline` — reads `nowMs()` at six sites (78, 110, 117, 172, 190, 329).
- `PowerCircuit` — reads `monoMs()` at three sites (193, 264, 306), and has **no `now` option
  at all**.
- `PowerCron` — reads `nowMs()` at five sites (225, 281, 306, 384, and the `_run` default).
- `PowerEventLoopMonitor` — reads `nowMs()` at five sites (109, 194, 344, 445, and one more).

`PowerHeartbeat`, `PowerPool`, `PowerWebSocketClient`, `PowerWebTransportClient` and
`PowerSocketAdapter` read the clock too, but through timer handles rather than deadline
arithmetic, so an injected clock would not change their behaviour — they are out of scope for
this task and were wrongly listed.

And `src/utils/now.js` documents, with two measured consequences, that `monoMs()` is
**deliberately unmovable**: it never reads `Date.now()`, so a harness that fakes the wall
clock cannot drive the four helpers that use it. The documented workaround is the limiter's
`now` option.

So a MapLibre application that calls `setNow()` to freeze time for a deterministic test gets
**no effect** on `PowerDeadline`, `PowerCron`, `PowerCircuit` open windows, or
`PowerEventLoopMonitor` — and cannot inject a clock into `PowerCircuit` at all. That is four
helpers, not ten, and the fix is correspondingly smaller.

This is not a performance gap, it is an **integration** gap, and it is exactly the kind that
makes a library feel foreign in an ecosystem: the host has a time-freezing convention and we
do not honour it. The fix is small and mechanical — accept an injectable clock on the helpers
that lack one, defaulting to the current module clock — but it touches ten files and must not
regress the 141 ns `nowMs()` measurement that `PERF-007` and `RES-019` are built on. §6
shows it is more than an integration nicety: it is a correctness prerequisite for two of the
four real workloads.

**F3 — MapLibre bounds image parallelism (16) but exposes no bound on tile or GeoJSON worker
traffic.**

`setMaxParallelImageRequests` is documented as covering _"images (raster tiles, sprites,
icons)"_. There is no equivalent for vector-tile requests, and none for the messages a
`GeoJSONSource` sends to its worker. An application that wants to bound in-flight tile
requests — the tileserver-rs numbers show why you would, with z14 diverging from 1,496 req/s
to 239 depending on the backend — has to do it inside its own `addProtocol` handler.
`PowerSemaphore` and `PowerBulkhead` are the right primitives and the recipe is short, but
the _discovery_ is the deliverable: nobody would guess that MapLibre's one concurrency knob
does not cover the thing they care about.

### 5.4 What MapLibre already does better than we would

Recorded so this section is not read as a list of deficiencies.

- **The diff protocol.** `GeoJSONSourceDiff` / `GeoJSONFeatureDiff` are ordered, id-keyed,
  publicly typed and versioned. Anything we designed would be worse by virtue of being second.
- **The worker pool.** Round-robin `Dispatcher.getActor()`, `prewarm()` that survives map
  teardown, per-bundler `setWorkerUrl()`. `PowerPool` is autoscaling with adaptive admission,
  a _different_ design for a _different_ problem (your workers, not MapLibre's tile workers).
  They compose; they do not compete.
- **Clustering.** supercluster is embedded. 6M points in a browser.
- **Tiling.** `@maplibre/geojson-vt` with a fully specified `GeoJSONVTOptions`, including
  `indexMaxZoom` / `indexMaxPoints` tuning.
- **Time freezing.** `setNow()` / `restoreNow()` is a genuinely good testing API, and it is
  the reason F2 is worth fixing rather than working around.
- **The `dataabort` event.** MapLibre tells you when it dropped a queued update. That is more
  than most libraries do, and it is the hook a coalescer's drop policy should report through.

### 5.5 The extension points MapLibre does _not_ have

Recorded because it is the complement of §5.2: it tells us where a third-party library can
and cannot help, and it comes from the maintainer discussion on PR #8670 rather than from
inference.

Asked whether the public API could be adjusted instead of putting prefetch in core, the PR
author replied with what that would take **(E)**:

> - open the currently private Tiles class to access the tiles lifecycle
> - enable creating off-screen cache
> - abstract the animation paths and make them public
> - add an event per frame rendering (to enable the fetch ahead)

and concluded _"I think it's not worthy the added complexity."_ A collaborator had earlier
suggested the opposite — _"better to define a minimal set of public API that can help like
the addition of covering tiles which was added to support similar cases"_ — so this is a live
design disagreement, not a settled position.

**What it means for us (O).** Each item on that list is a place where a third-party library
_currently cannot_ help, because the hook does not exist:

| Missing hook                          | Consequence for a third party                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Private `Tile` class / tile lifecycle | Cannot observe or influence tile state; the `maplibre-preload` plugin had to hijack the class, described in the PR as _"a community hack"_. |
| No off-screen cache creation          | Cannot pre-warm tiles into a cache the render loop will read; the plugin pushed onto `fetch` and the browser cache instead.                 |
| Animation paths not public            | Cannot know where the camera is going; the plugin _"reconstructs the flight itself"_, a second implementation to keep in step.              |
| No per-frame render event             | Cannot time a fetch-ahead to the render loop; the plugin fell back to its own clock.                                                        |

**The practical consequence for this plan:** any recipe we write for UC4 must state plainly
that it works through `addProtocol` + `addSourceType` and the public `Camera` API, and that
it cannot reach tile lifecycle. If PR #8670 merges, `preload: true` covers the core case and
our recipe's value narrows to _custom sources and deck.gl layers_, which core prefetch does
not cover. That is a narrower but real niche, and it is the honest scope.

---

## 6. Four real use cases

The gap analysis in §4 and the API match in §5 are both top-down. This section is bottom-up:
it takes four workloads a geospatial developer actually ships, works out where the time goes
in each, and asks which helpers apply. They turn out to have **different bottlenecks**, and
that difference is the most useful thing in this document — it is what tells us which
candidates matter and which are irrelevant.

The fourth, UC4, is drawn from MapLibre PR #8670 and is included because it is the one use
case where the cost of the composition being invisible has been priced in public.

### 6.1 The four workloads side by side

|                   | **UC1** Realtime dashboard                                       | **UC2** Geospatial simulator                                               | **UC3** Map-based game                 | **UC4** Camera-movement prefetch                                                     |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Example           | fleet tracking, AIS vessel tracking, IoT sensor map, air traffic | traffic sim, crowd sim, wildfire spread, UAV swarm, logistics digital twin | location-based game, map strategy game | `flyTo` / `easeTo` over a slow network; guided tour; "jump to result" in a search UI |
| Entities          | 1k – 100k+                                                       | 1k – 100k+                                                                 | 10 – 1k                                | tiles, not entities                                                                  |
| Update rate       | 1 – 30 Hz per entity, externally driven                          | fixed 30 – 60 Hz, internally driven                                        | 60 Hz render, event-driven logic       | one burst per camera movement                                                        |
| **Bottleneck**    | inbound message rate × source-update cost                        | simulation step cost                                                       | frame budget and input latency         | **request budget vs. flight duration**                                               |
| Clock             | wall clock; TTL expiry of stale entities                         | **must be controllable and deterministic**                                 | fixed timestep, decoupled from render  | the movement's own sampled path                                                      |
| Allocation        | moderate                                                         | high (state snapshots)                                                     | **must be zero on the hot path**       | low                                                                                  |
| Network           | yes, and dominant                                                | none                                                                       | minimal                                | **yes, and the whole problem**                                                       |
| Failure mode      | backpressure, then silent data loss                              | non-determinism, unreproducible runs                                       | a dropped frame                        | **wasted requests on ground the camera has left**                                    |
| What "fast" means | keep the main thread under 16.7 ms while 250k mutations/s arrive | same inputs → same outputs, every run                                      | never miss a frame                     | arrive at a drawn map, having abandoned nothing                                      |

**The most important row is the bottleneck row.** UC1 is throughput-bound, UC2 is
correctness-bound, UC3 is latency-bound, UC4 is _budget_-bound — the constraint is how many
tiles can be fetched in the time the flight takes, across a fixed number of connections. A
helper that helps one can be irrelevant or actively harmful to another: a coalescer is
essential to UC1, useful to UC2, and a liability in UC3 if it adds a frame of input latency.

### 6.2 UC1 — Realtime geospatial dashboard with lots of entities

**The workload, with real numbers.** Placematic's fleet-dashboard case study **(E)** puts
200 trucks at 10-second intervals at **648,000 GPS packets per day**, and notes that _"at
1,000 trucks on 5 s, it is 6.5 million"_, with the warning that _"GPS volume is the quiet
problem. Anything per-point multiplies by fleet size × ping rate."_ A published
fleet-management case study **(E)** reports 5,000+ vehicles where _"the UI became sluggish
when rendering more than 500 vehicles simultaneously"_ with off-the-shelf tooling, solved by
_"using clustering and WebGL layers instead of DOM nodes."_ TRAVIC, a peer-reviewed
transit-visualisation client **(E)**, demonstrates _"many thousands of vehicle movements in
real-time"_ and deliberately _"uses lower refresh rates at lower zoom levels."_

So: 5,000 entities at 1 Hz is 5,000 messages/second. 50,000 at 5 Hz is 250,000/second. The
frame budget allows ~60 updates/second. **The ratio is the whole problem.**

**Where the time goes.**

1. **Inbound decode.** 250k msg/s of JSON is the dominant CPU cost before anything
   geospatial happens. `powerMessageCodec`'s `framed` codec and `createFrameDecoder` exist
   for exactly this; `PowerWebSocketClient` already negotiates `permessage-deflate`, which
   aisstream.io's own docs **(E)** recommend to _"avoid dropped events."_
2. **Dedup and reorder.** Duplicate position reports and out-of-order datagrams are normal on
   lossy mobile links. `PowerDeduplication` and `PowerSequencer` (whose `missing()` is
   already a NACK payload) cover both.
3. **Fan-out.** The map is one consumer; the table, the alert engine, the recorder and the
   WebSocket re-broadcast are others. `PowerRealtimeHub` gives each a bounded queue and a
   declared drop policy — the difference between _"we dropped 3% of updates and know it"_ and
   aisstream's _"the service drops messages"_ with no client-side signal.
4. **Entity store with expiry.** A vessel that stops reporting must disappear. The AWS sample
   fleet tracker **(E)** shows exactly this UI: _"time since last update"_ per vehicle.
   `PowerTTLMap` is that primitive, already shipped.
5. **Source update.** This is where §3.1's 200 ms `JSON.stringify` lives, and it is the step
   that has no helper today.
6. **Render.** MapLibre's own large-data guide **(E)** is a list of application-level
   transformations (drop properties, reduce precision, simplify, cluster, cap `maxzoom`) with
   no helper behind any of them.

**The concrete pipeline.**

```
WebSocket / MQTT
  → PowerWebSocketClient            reconnect, backoff, ping/pong, permessage-deflate
  → powerMessageCodec               framed decode (or JSON.parse)
  → PowerDeduplication              drop duplicate position reports inside a window
  → PowerSequencer                  reorder; missing() is the NACK payload
  → PowerRealtimeHub                fan-out, per-subscriber bounded queue + drop policy
      ├─ map consumer  → PowerTTLMap (entity store, TTL = staleness threshold)
      │                  → PowerGeoCoalescer  ← GEO-009, the missing piece
      │                  → GeoJSONSource.updateData(diff)
      ├─ table consumer → same store, different projection
      ├─ alert consumer → PowerEventBus
      └─ recorder       → PowerQueue, drained to IndexedDB off the hot path
  → PowerApdex {target: 16.7} + PowerEventLoopMonitor   frame budget + host attribution
```

**Verdict.** This is the use case the candidates were designed for, and the evidence is
strongest here. GEO-009 is not an optimisation in this workload — **it is the only thing that
makes the workload possible at all.** Without it you either block the main thread (MapLibre
#106's _"the main thread blocks forever"_) or drop data silently. Payload size still matters —
it multiplies by fleet size × ping rate — but the fix is the GEO-020 precision recipe and
MapLibre's own advice to serve GeoJSON from a URL so the worker parses it, not a new codec.

**What UC1 teaches that §4 did not.** The coalescer's drop policy is not a nice-to-have, it
is the product decision. _"Show me every vehicle, and accept that the map is 3 seconds
behind"_ and _"show me the freshest 5,000 and drop the rest"_ are different products.
`PowerRealtimeHub` already makes that a declared option rather than an accident; the coalescer
must inherit that property, and GEO-002 must measure it (see F1).

### 6.3 UC2 — Geospatial simulator with lots of entities

**The workload.** Traffic simulation, crowd simulation, wildfire spread, UAV swarms,
logistics digital twins. Published browser implementations scale from 10,000 to 100,000+
agents **(E)**, with position-based-dynamics crowd methods reaching _"on the order of a
hundred thousand agents"_ at interactive rates **(E)** and WebGPU compute reaching 10,000+
agents at 60 FPS **(E)**.

**The bottleneck is not the map.** It is the simulation step, and the hard requirement is
**determinism**.

RepliCore **(E)** is the most directly relevant work found. It addresses precisely this:
_"Browser-based simulations execute over asynchronous runtime mechanisms including event
loops, rendering callbacks, and independently scheduled Web Workers, causing simulation
progression to depend on runtime timing and callback scheduling behavior."_ Its model is
logical time `t_k = k·Δt` with _"state updates … performed only at explicit simulation-step
boundaries"_, state partitioned across workers, and the reported result is that _"all
configurations produced bitwise-identical states across runs"_ under 1/2/4/8/16 workers and
at 60, 30 and 10 FPS with rendering disabled.

CrowdFlow **(E)** states the same discipline from the implementation side: _"60Hz
fixed-timestep physics"_, _"spatial hash grid for O(n) neighbor lookups, zero-allocation hot
loops"_, _"selective layer redraws"_, and — the line that matters most for us — _"UI polls
stats at 10fps — never re-renders for simulation state."_

**Where the time goes.**

1. **The step itself.** O(N) or O(N log N) per step. Neighbor queries want a spatial hash or
   kdbush; both are fast (§3.8) and neither is ours to write.
2. **Partitioning across workers.** `PowerPool` + `PowerChunker` is the composition, and
   RepliCore's partitioned-state model maps onto it directly.
3. **Snapshot and transfer.** The render thread must never read live sim state. A columnar
   snapshot (`Float32Array` positions + a property table) transferred zero-copy is the right
   shape — and `powerMessageCodec`'s `RAW` codec plus `collectTransferables()` already moves
   exactly that, with no new helper. The application owns the column layout because the
   application owns the simulation.
4. **The clock.** This is where our library currently fails. See below.
5. **Frame budget.** The step must fit in the frame or be shed. `PowerDeadline` +
   `PowerBrownout` compose this.

**The concrete pipeline.**

```
fixed timestep loop, Δt = 1/60 (logical time t_k = k·Δt)
  → PowerPool + PowerChunker        partition entities across workers
      per worker: spatial hash / kdbush neighbor query
                  PowerDeadline     cap the step; shed if exceeded
  → columnar snapshot (Float32Array + property table) → RAW codec, zero-copy transfer
  → PowerObserver                   render reads a snapshot, never live state
  → render at 60 Hz with interpolation alpha = accumulator / Δt
  → PowerApdex {target: 16.7} + PowerEventLoopMonitor
  → PowerBrownout                   degrade: fewer agents, coarser LOD, drop labels
```

**Verdict, and the finding that reorders the plan.**

UC2 turns GEO-039 from an integration nicety into a **product requirement**. A simulator that
cannot control its clock cannot be deterministic, and RepliCore's whole contribution is that
determinism under an asynchronous browser runtime is achievable but requires logical time
decoupled from wall time. Our position today is F2: four limiters accept `now`, `PowerCircuit`
accepts none, and ten more helpers read the module clock directly.

So a simulator built on this library cannot be made reproducible without hand-threading a
clock into ten places, and cannot do it at all for `PowerCircuit`. That is a real defect for
this use case, and it is cheap to fix relative to what it unlocks.

**Two further UC2 findings.** First, **the render must never read live state** — CrowdFlow's
_"UI polls stats at 10fps — never re-renders for simulation state"_ is the same lesson as
`PowerObserver`'s snapshot model, and it is worth stating in the guide as a rule rather than
leaving it to be rediscovered. Second, **interpolation is the app's job, scheduling is ours**:
Gaffer's fixed-timestep pattern **(E)** is accumulator + while-loop + `alpha = accumulator /
step` + a clamp to prevent the _"spiral of death"_. The accumulator, the catch-up cap and the
clamp are scheduling and belong in a helper; `alpha` and the lerp are the application's. See
GEO-044.

### 6.4 UC3 — Map-based videogame

**The workload.** A location-based or map-strategy game. Entity counts are small — tens to a
thousand — and the requirement is absolute: 60 fps, or the game feels broken.

**The bottleneck is the frame budget, and the enemy is allocation.** The W3C Frame Timing
spec **(E)** states the constraint precisely: _"If all of the work within each execution of
the event loop (i.e. within a 'frame') is completed in allotted time budget (e.g. 16.6ms for
60Hz refresh rate), the browser can guarantee a smooth and responsive experience. However, if
the work within the frame exceeds this time budget … then one or more frames is skipped."_

The fixed-timestep literature **(E)** adds the three failure modes a variable timestep
introduces — _"numerical instability"_, _"tunneling"_, _"non-determinism: same inputs +
different framerate = different outcome"_ — and the memory cost of the fix: _"current +
previous state for interpolation (+16-64 bytes per object)."_ A published TypeScript
implementation **(E)** shows the exact shape: injectable `clock`, injectable `scheduler`,
`step`, `maxUpdates` (the catch-up cap), `timeScale`, `onUpdate(dt)`, `onRender(alpha)`, a
frame-time cap of 0.25 s to prevent the spiral of death, and metrics `{fps, ups,
avgFrameTime}`.

**Where the time goes.**

1. **Input coalescing.** A drag produces dozens of `pointermove` events per frame. They must
   become one logical input. This is `PowerBatch` with a frame clock — the same flush clock
   GEO-009 needs, reused.
2. **The fixed-timestep update.** Accumulator + catch-up cap. See GEO-044.
3. **Spatial query.** What is near the player, what is in view. kdbush, not ours.
4. **Render.** MapLibre custom layer or a deck.gl `MapLibreOverlay` in interleaved mode.
5. **Frame budget enforcement.** Nothing currently does this. `PowerDeadline` +
   `PowerBrownout` compose it; the composition is undocumented.
6. **Allocation.** Every per-frame allocation is a potential GC pause. `PowerQueue`,
   `PowerPriorityQueue` and `PowerBuffer` are already zero-allocation and are exactly the
   right primitives — this is the one use case where the library's existing zero-alloc design
   pays off directly.

**The concrete pipeline.**

```
requestAnimationFrame
  → PowerBatch (frame clock)        coalesce pointermove/wheel into one logical input
  → fixed timestep update           accumulator, Δt, maxUpdates catch-up cap  ← GEO-044
  → kdbush spatial query            what is near the player
  → render                          MapLibre custom layer / MapLibreOverlay
  → PowerApdex {target: 16.7}       frame budget attainment
  → PowerEventLoopMonitor           is a long frame ours or the host's?
  → PowerBrownout                   shed: particles → labels → picking → geometry
  → PowerGCRA / PowerThrottle       rate-limit outbound calls (leaderboard, telemetry)
```

**Verdict.** The library is _least_ needed here and _most_ likely to be misused. A columnar
carrier is irrelevant (N is small; a `Float32Array` per entity is noise), and a precision pass
is irrelevant (no network payload). What UC3 needs is the zero-allocation primitives we already have, a
documented frame-budget recipe, and a fixed-timestep scheduler.

**The UC3 warning.** A coalescer that adds a frame of input latency is a regression in a game
and an optimisation in a dashboard. GEO-009 must therefore document its latency cost
explicitly and must not be recommended for input paths. This is the clearest illustration in
the document of why the four use cases must not share one recommendation.

### 6.5 UC4 — Camera-movement prefetch over a slow network

**The workload.** `flyTo`, `easeTo`, `panTo` and `zoomTo` request their tiles _as the camera
reaches them_, so a movement over a slow network spends much of its flight at reduced detail
or blank. This is the use case behind MapLibre PR
[#8670](https://github.com/maplibre/maplibre-gl-js/pull/8670), _"Add a `preload` option to
animated camera movements"_ **(E)**, which ports the `maplibre-preload` plugin into core.

**Why this use case matters more to this analysis than its size suggests.** The PR's own
"Why" section is the strongest evidence in this document for the documentation thesis:

> "The plugin solves the same problem from outside, and does it well enough that I have been
> using it — but working around the public API cost it a lot, and most of that cost is now
> avoidable from inside."

What the plugin had to do to work from outside **(E)**: monkey-patch `panTo` / `zoomTo` /
`easeTo` / `flyTo`; hijack the `Tile` class (described in the PR as _"a community hack"_) to
reach the manager; fall back to `fetch` for custom protocols; reconstruct the flight path
itself, which is _"a second implementation to keep in step with the first"_ and is why
`zoomTo` needed a bug fix of its own in the plugin's 1.1.0; and wait for the preload before
animating, so _"the wait is paid in full before anything is seen."_

**That is the documentation gap, priced.** A working, used, published solution existed, and
it still cost a monkey-patch, a class hijack, a duplicated flight-path implementation and a
blocking wait — because the composition was not visible from outside. This is the argument
for GEO-014 and GEO-046 in its most concrete form.

**The measured results** (real Chrome, `test/bench/e2e/preload_flight.mjs`: a local tile
server with a per-tile delay, a cold origin, two sources; the measure is the share of the
**frame drawn** when the camera arrives, not the share of tiles, _"because a missing tile at
the horizon occupies almost no pixels and the two are not the same thing"_) **(E)**:

| flight             | per-tile delay | % viewport drawn        | tiles arrived  | requests |
| ------------------ | -------------- | ----------------------- | -------------- | -------- |
| 3 s, NYC→Tokyo z11 | 400 ms         | not measured → **100%** | 37% → **100%** | 112 → 48 |
| 3 s, NYC→Tokyo z11 | 600 ms         | 13% → **70%**           | 33% → **100%** | 97 → 36  |
| 3 s, NYC→Tokyo z11 | 800 ms         | **0%** → 67%            | 0% → 67%       | 100 → 26 |
| 3 s, z3→z14        | 800 ms         | not measured → **100%** | 75% → **100%** | —        |
| 3 s, pitch 55      | 600 ms         | 16% → **92%**           | 14% → 57%      | 96 → 30  |

And the number that reframes the problem: _"A moving camera's network cost is dominated by
requests it abandons. Over that flight the render loop started about 100 tile requests and
**abandoned 82 of them**, because the viewport covers ground and then uncovers it
mid-download. With `preload` that drops to **zero**, and total requests fall by two to four
times."_

**The design, and why it is a scheduling problem.** `Camera` builds a `CameraMovement` — the
path, the easing and the camera handler — and hands the same object to both the animation and
the preload. The preload samples it, works out what each source covers at each sample, and
requests those tiles _"through a priority cursor bounded by an in-flight window."_ Four
decisions, each forced by a measurement **(E)**:

1. **The destination is read first.** _"A path ends where it is going, so its last sample is
   the destination."_ Reading in camera order — _"which is what I wrote first"_ — spent the
   request budget on ground the camera was about to leave, brought not one destination tile
   in before arrival, and because those trip tiles queued ahead, the destination landed
   **20–770 ms later than with no preload at all**.
2. **Read ahead by time, not by sample count.** Two samples is worth 1.26 s of warning on a
   ten-second flight but ~50 ms on a one-second flight, _"because a longer movement is
   divided into more samples."_ The lead is one second's worth, floored at two.
3. **Cap requests in flight, and share the window.** `MAX_TILES_IN_FLIGHT = 12` across all
   sources, each source given an equal share of what is left, a tile landing making room for
   the next. _"Chromium holds about six connections open to one origin. Twelve is roughly
   twice that, and it is the optimum of the three I tried."_ The sweep: window 6 → 53
   requests, 23 abandoned, 6 outstanding at arrival; **12 → 36 requests, 0 abandoned, 6
   outstanding**; 24 → 46 requests, 5 abandoned, 18 outstanding.
4. **A drained queue is not a finished preload.** Ending the preload whenever nothing was
   outstanding _"killed it as soon as the destination landed, leaving the rest of a long
   flight unloaded, which is most of it."_

Also measured and rejected: raising `MAX_FRAME_COUNT` from 16 to 48 (trip coverage 50%
against 53%, _"because more samples shrink a fixed sample lead in time terms and the two
effects cancel"_); and sorting by `coveringTiles`' unused `tileDistanceToCamera` instead of
`distanceSq` (92% against 92% on a pitched mercator flight, 87% against 85% on a globe — a
tie, so the existing reference stays).

**The arrival/interruption split is a resource-allocation policy, and it was settled on user
experience rather than bytes.** Keeping in-flight requests when a movement is interrupted
costs **14.7% of viewport recovery** (4533 ms against a 3951 ms baseline, three runs each,
±15 ms). _"A blank viewport the user is looking at is far more visible than a dozen tiles
they will probably never request again, so the asymmetry is worth having."_ Telling arrival
from interruption needs the one thing only the render loop knows — that it reached the end of
the path — and until that was separated, _"every gesture interrupting a flight held its
requests and paid the full 580 ms"_, which the PR notes was _"the most common interruption …
the one case I had got wrong."_

**Cost.** ~0.59 ms once per movement (down from 2.50 ms in the first working version; p99
1.57 ms against 4.53 ms). Bundle **+4,925 bytes raw, +1,512 gzip** — over the 256-byte gzip
quota the size test allows, and _"about half a kilobyte gzip larger than the plugin this
replaces."_ The PR states the trade plainly rather than hiding it.

**Known limitations, stated rather than buried (E):** sub-second movements dip in-flight
coverage from 65% to 59% (_"a real regression"_, cause: trip tiles requested at `t=0` for a
camera that arrives before they could land; a duration-aware window is the fix); a tail of
requests for ground already behind (6 of 36 at 600 ms/tile, 12 of 26 at 800 ms); no
preloading before a movement is committed, so no hover-to-preview; and at a pitch not every
destination tile arrives — _"a pitched destination covers 42 tiles, and four seconds at
600 ms per tile across six connections affords about forty tile fetches in total."_

**What this use case means for our plan — and what it does not.**

- **It does _not_ mean we build a prefetch helper.** MapLibre PR #8670 is adding `preload:
true` to core for exactly this problem. A helper that duplicates a feature the host library
  is actively adding is the definition of "building an owned maplibre feature", and it fails
  the §1.1 scope test. **GEO-016 is therefore rejected, not restored** — an earlier revision
  of this document restored it, and that was wrong for this reason.
- **What survives is the recipe for where core prefetch does not reach.** Core `preload` goes
  through the ordinary source path, so it covers built-in sources. It does not cover custom
  sources registered through `addSourceType`, and it does not cover deck.gl layers at all.
  That is a genuine gap, and filling it with a recipe is exactly the right scope. GEO-048
  carries it.
- **The window sweep is still a benchmark worth hosting** (GEO-049), because the optimum is
  host-dependent — PR #8670 measures 12 as optimal against Chromium's ~6 connections per
  origin, and that ratio will not hold everywhere. But the benchmark informs the _recipe_,
  not a helper.
- **The arrival/interruption split is a pattern worth naming**, not a helper worth building:
  a resource-allocation decision made explicit and measured rather than left implicit. That is
  `PowerBrownout`'s declared-policy pattern and `PowerRealtimeHub`'s drop policy, in a
  different costume, and the recipe should say so.
- **The reviewer pushback is directly relevant to our own positioning.** A maintainer asked
  _"did you explore if we could instead adjust the public api to better allow for this
  use-cases?"_, and another answered that it would be _"better to define a minimal set of
  public API that can help like the addition of covering tiles which was added to support
  similar cases."_ The author's reply lists what that would take: _"open the currently
  private Tiles class to access the tiles lifecycle; enable creating off-screen cache;
  abstract the animation paths and make them public; add an event per frame rendering (to
  enable the fetch ahead)."_ **That list is a precise inventory of the extension points
  MapLibre lacks**, and it is recorded in §5.5 because it tells us exactly where a
  third-party library can and cannot help — which is the boundary of our own scope.

### 6.6 What the four use cases collectively change

| Candidate                                                                                        | UC1 dashboard                                                       | UC2 simulator                               | UC3 game                                       | UC4 prefetch      | Collective verdict                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Columnar carrier (GEO-005)                                                                       | **High** — network payload                                          | **High** — state snapshot                   | None                                           | None              | **REJECTED as a helper.** `CODECS.RAW` + `collectTransferables()` already move typed arrays verbatim and zero-copy; what was left was a data structure and a convention. The measurement (GEO-001) survives on its own. §1.4, §4.1. |
| GEO-009 coalescer                                                                                | **Essential** — the only way to fit 250k mutations/s into 60 frames | Useful — decouple sim rate from render rate | **Harmful if misapplied** — adds input latency | None              | **BUILD**, with an explicit "do not use on input paths" warning.                                                                                                                                                                    |
| Precision pass (GEO-012)                                                                         | **High** — payload × fleet × rate                                   | None                                        | None                                           | None              | **REJECTED as a helper; survives as the GEO-020 recipe.** turf owns `truncate`, so a standalone variant is a performance claim about someone else's feature and a second thing to choose between. §4.2.                             |
| GEO-039 injectable clock                                                                         | Medium — TTL expiry                                                 | **Essential** — determinism                 | **Essential** — fixed timestep                 | None              | **BUILD.** Upgraded from integration nicety to product requirement. Two of four use cases cannot be built correctly without it.                                                                                                     |
| GEO-016 prefetch helper                                                                          | None                                                                | None                                        | None                                           | Would be **High** | **REJECTED — out of scope.** MapLibre PR #8670 adds `preload: true` to core. Duplicating a feature the host is actively adding fails the §1.1 test. The recipe for custom sources and deck.gl survives as GEO-048.                  |
| GEO-044 fixed-timestep scheduler                                                                 | None                                                                | Would be **High**                           | Would be **High**                              | None              | **REJECTED — out of scope.** Not a geospatial feature, not a gap maplibre or turf leaves, and well-covered by existing implementations. Belongs on the general roadmap if anywhere.                                                 |
| Zero-alloc primitives (`PowerQueue`, `PowerPriorityQueue`, `PowerBuffer`)                        | Useful                                                              | Useful                                      | **Essential**                                  | Useful            | **Already shipped.** The deliverable is a recipe saying so, not code.                                                                                                                                                               |
| Frame-budget recipe (`PowerApdex` + `PowerEventLoopMonitor` + `PowerDeadline` + `PowerBrownout`) | High                                                                | High                                        | **Essential**                                  | High              | **RECIPE.** No new code.                                                                                                                                                                                                            |

**Four conclusions the use-case pass produces that the top-down pass did not.**

1. **GEO-039 is the only unconditional code deliverable left.** The clock is a _correctness
   prerequisite_ for two of the four use cases — a simulator or a game built on this library
   today cannot be made deterministic without hand-threading a clock into ten places. Every
   other candidate is either conditional on a measurement (GEO-009) or a recipe. That is a
   thinner plan than the first draft, and it is the honest one.

2. **GEO-009 needs a usage boundary, not just a benchmark.** It is essential in UC1, useful
   in UC2, and harmful in UC3 if applied to input. The guide must say which paths it is for,
   and the JSDoc must carry the latency cost. A helper that is correct but misapplied is
   still a defect we shipped.

3. **A use case worked end to end is what tests a scope judgement — in both directions.** UC4
   first _rehabilitated_ GEO-016, by showing the prefetch priority policy was far more than
   "five lines of arithmetic". It then _rejected_ it, once it was clear that MapLibre is
   adding `preload: true` to core and a helper would duplicate a feature the host owns. Both
   conclusions came from the same use case, and the second only arrived with the scope test in
   §1.1 applied deliberately. The general lesson: **working a real use case is what turns a
   plausible-sounding candidate into a scoped or rejected one, and it has to be done against
   an explicit scope statement, not just against the evidence.**

4. **The highest-value deliverable is unchanged, and the use cases confirm it — UC4 most of
   all.** All four pipelines are compositions of shipped helpers plus one or two gaps. UC4
   prices the cost of that composition being invisible: a working, used, published plugin
   that still needed a monkey-patch, a `Tile` class hijack, a duplicated flight-path
   implementation and a blocking wait. Nobody outside this repository can see that
   `PowerPriorityQueue` + `PowerBulkhead` is a priority cursor with an equally-shared
   in-flight window, because `guides/geo.md` does not exist. Writing it is still the first
   task.

---

## 7. What we will not build, and why

Recorded so the next proposal does not repeat the work. Each is a **REJECT** with a reason
that is not "it is hard". These are the content of GEO-024 (the ADR).

| Candidate                                                      | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spatial analysis (distance, area, buffer, intersection, union) | turf.js is 10.4k stars, MIT, and modular — `@turf/*` packages import individually. `buffer` delegates to JSTS, a large transitive dependency we cannot vendor under the zero-dependency rule. No measured premise that our version would be faster.                                                                                                                                                                                                                                                                                        |
| A spatial index (R-tree / KD-tree / packed Hilbert)            | flatbush indexes 1M rectangles in 109 ms and kdbush is 5–8× faster than rbush at indexing (§3.8). We would be reimplementing a solved, benchmarked data structure and losing.                                                                                                                                                                                                                                                                                                                                                              |
| Point clustering                                               | supercluster is the reference implementation, is embedded in MapLibre, and clusters 6M points in a browser.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| MVT / PBF encoding                                             | vt-pbf and @maplibre/vt-pbf exist. Protobuf wire-format compliance is a correctness exercise with a published spec, not a performance one.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Projection / reprojection math (Web Mercator, EPSG codes)      | math.gl, proj4 and MapLibre's internals own this. A subtle correctness surface (antimeridian, pole clipping, non-linear latitude) with **no** measured performance premise. High risk, low ROI.                                                                                                                                                                                                                                                                                                                                            |
| H3 / S2 / geohash encoding                                     | h3-js and geohash libraries exist. The integer-vs-string tradeoff is documented (§3.9); the win is in _choosing_ the key shape, not in a faster encoder.                                                                                                                                                                                                                                                                                                                                                                                   |
| A faster GeoJSON parser                                        | `JSON.parse` is native and beats anything writable in JS. The win is in _not parsing_ — see GAP-1.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A `PowerMap` / map-engine abstraction                          | That is a rendering engine. Out of scope by the library's own definition ("small, fast, dependency-free helpers"), and it would make this package a competitor to MapLibre rather than a complement.                                                                                                                                                                                                                                                                                                                                       |
| Payload compression for geo                                    | **Already measured and rejected.** `bench/claims.js payload` exists precisely to settle "why compression does not pay in-process". Do not re-litigate.                                                                                                                                                                                                                                                                                                                                                                                     |
| A `SharedArrayBuffer` permit pool for geo                      | **Already measured and rejected.** `bench/claims.js permit` takes the same dispatch decision two ways — a plain field read (`tasks < this._maxTasksPerWorker`, which is what `PowerPool` already does) and an `Atomics.load` — and `AGENTS.md` records the atomic at **6.4× more expensive**. The premise was inverted, not merely unproven.                                                                                                                                                                                               |
| A structured-clone-to-bytes codec                              | **Already rejected in `powerMessageCodec`'s own JSDoc**: the structured-clone algorithm does not produce bytes, and there is no portable way to serialise it without a serialization library.                                                                                                                                                                                                                                                                                                                                              |
| Building on `importScriptInWorkers()`                          | Documented as _"using some very internal classes and flows … considered experimental and can break at any point."_ A geo story built on it breaks on a MapLibre minor. Use the stable `addProtocol` + `addSourceType` surface instead.                                                                                                                                                                                                                                                                                                     |
| **A camera-movement prefetch helper** (GEO-016)                | **Out of scope — the host owns this feature.** MapLibre PR #8670 adds `preload: true` to core, sampling the movement's own path and requesting tiles through a priority cursor bounded by an in-flight window. A helper duplicating that is the definition of "building an owned maplibre feature". The recipe for where core prefetch does not reach — custom sources via `addSourceType`, and deck.gl layers — survives as GEO-048.                                                                                                      |
| **A standalone coordinate-precision helper** (GEO-012)         | **Out of scope — the host owns this feature.** turf.js owns `truncate`. A typed-array variant is a _performance variant of a filled gap_, not a filled gap, and it makes the DX worse: a second truncate to choose between, with different duplicate-collapse and ring re-closing behaviour. Survives as the GEO-020 recipe. §4.2, and GEO-003's measurement (§10.4) shows why: rounding saves 40.6% on line-heavy JSON, 10.8% on point-heavy JSON, and **0% on a flat buffer**, so the win is representation choice, not a rounding pass. |
| **A fixed-timestep game-loop helper** (GEO-044)                | **Out of scope — not a geospatial feature.** It is not a gap maplibre or turf leaves, and it is not one this library is unusually placed to fill: the pattern is ~50 lines with many existing implementations. It may belong on the _general_ roadmap as a scheduling primitive, but it does not belong in a geo proposal.                                                                                                                                                                                                                 |

---

## 8. Recommendations

Ordered by (confidence × value) ÷ risk.

### R1 — Ship the documentation first, before any code. (GEO-014, GEO-022, GEO-046)

`guides/geo.md` as a router in the shape of `guides/metaGuide.md` ("I have this problem, what
do I reach for"), carrying the four use-case pipelines from §6 and a "when this helper is the
wrong choice" section; plus a "Geospatial" section and quick-chooser rows in the meta guide;
plus an ADR recording the rejections in §7.

This is the only deliverable that is unambiguously positive-ROI. It costs no API surface,
cannot regress, requires no benchmark, and it is the difference between the geospatial
ecosystem being able to find this library and not. It also _generates the evidence_ for
R2–R5: real usage will tell us which of the candidates actually hurts, which is a better
signal than any benchmark we could write today.

**UC4 prices this argument more concretely than anything else in the document.** A working,
used, published plugin (`maplibre-preload`) solved camera-movement prefetch from outside the
public API, and still cost a monkey-patch of four camera methods, a `Tile` class hijack
described by its own author as _"a community hack"_, a duplicated flight-path implementation
that needed its own `zoomTo` bug fix, and a blocking wait. The composition existed; it was
simply not visible.

### R2 — Fix the clock before building anything else. (GEO-039)

MapLibre exposes `setNow()` / `restoreNow()` so an application can freeze time for
deterministic rendering and tests. Four of our helpers read the module clock directly with no
injection point — `PowerDeadline`, `PowerCircuit`, `PowerCron` and `PowerEventLoopMonitor` —
so a MapLibre app which freezes time gets no effect on any of them, and cannot inject a clock
into `PowerCircuit` at all.

This is not a performance gap, it is an integration gap, and it is the kind that makes a
library feel foreign in an ecosystem. The fix is mechanical — four constructors, one option
each — but it sits directly on top of a measured 141 ns hot path, so it gets its own task and
its own risk line rather than being bundled into a feature.

**Corrected scope.** An earlier revision said ten helpers and ten files. Reading the source
showed six already accept `now` — the four limiters via `attachLimiterClock`, plus
`PowerTTLMap` and `cache/core`, both of which carry a comment citing PERF-007. The lesson is
the one `AGENTS.md` records about guessed shapes: _read the code before writing the list._

**It is ranked second, above the carrier, because §6 shows it is a correctness prerequisite
for two of the four real workloads.** A geospatial simulator cannot be deterministic without
a controllable clock, and a map-based game cannot run a fixed timestep without one.

### R3 — Run the `geoencode` measurement, and let it stand on its own. (GEO-001)

Four arms, as specified in §3.4, on the MapLibre #106 payload shape (200 LineStrings × 4,500
coordinates) and on a point-cloud shape (1M positions). Report bytes, ms, and allocations.

**This is no longer gated on a helper** — GEO-005 is rejected (§1.4), because `CODECS.RAW` and
`collectTransferables()` already ship the transport. It stands on its own as the answer to a
question the ecosystem keeps guessing at: MapLibre #106 records geobuf tried and _"still takes
~200ms (same as before)"_, and `web-worker-string-benchmark` measures direct string transfer
beating an ArrayBuffer round-trip by 70–87% at 100 MB. Publishing the result — **including a
negative one** — is the contribution.

### R4 — Measure the coalescer end-to-end, and measure diff quality. (GEO-002, then GEO-009)

The `setImmediate` / 608× lesson is the single most relevant piece of institutional memory in
`AGENTS.md` for this candidate: _"a `setImmediate` change was measured at 608× per turn and
then found to be within noise end to end, because `PowerChunker` posts chunks as a batch and
the timers all expire together. Per-turn cost is not batch cost."_ Build the fake source to do
the real work (serialise, post, parse, index) so the measurement cannot be gamed by a cheap
stub.

The prior is higher than an earlier pass assumed, because MapLibre's public
`GeoJSONSourceDiff` fixes the output shape — we are filling a gap in an existing protocol, not
inventing one (F1). But the benchmark must report **diff quality** (mutations coalesced,
mutations dropped, drop policy honoured), not only latency. A coalescer that wins on
throughput by silently discarding half the mutations has not won, and MapLibre's `dataabort`
event is the observable that tells you it happened. If the honest composition — `PowerBatch`
plus a `Map` for the keyed merge — ties, ship the recipe and delete the helper.

### R5 — Ship the precision pass as a recipe, not a helper. (GEO-020)

turf.js owns `truncate`, and a second truncate makes the developer experience worse rather than
better. The recipe (GEO-020) carries the 8-line function for a caller who already holds
coordinates in a typed array, and points at `turf.truncate` for everyone else. GEO-012 is
rejected in §7.

### R6 — Do not build anything else. (§7)

Every other candidate is a recipe, and two candidates that looked like code are not. Resist
the pull: the moment this library ships a distance function, it will be asked for a buffer,
then an intersection, then a reprojection, and the zero-dependency rule and the "no `await` on
a hot sync path" rule will both be under pressure from a domain that genuinely needs them
broken. §7 is the document someone points at.

**The two that looked like code and are not.** A camera-movement prefetch helper (GEO-016)
would duplicate `preload: true`, which MapLibre is adding in PR #8670. A fixed-timestep
game-loop helper (GEO-044) is not a geospatial feature at all. Both were carried as candidates
in earlier revisions of this document; both fail the §1.1 scope test, and the recipe is the
right deliverable in the first case and nothing is the right deliverable in the second.

### R7 — Keep the scope test in front of every future candidate.

The test in §1.1 is one sentence and it did real work in this document: it moved two
candidates out of the plan, and it put a fence around a third (§4.2). It should be quoted in
`adr/0015` (GEO-024) so the next proposal is measured against it rather than against
enthusiasm.

---

## 9. Implementation plan

Status icons: ✅ done · 🟡 partial · ⬜ not started · ⏰ deferred · ➖ resolved by deletion ·
❌ rejected / won't do.

Priority: **P0** = blocks or de-risks everything else · **P1** = core deliverable ·
**P2** = valuable, not blocking · **P3** = nice to have.
ROI / Risk / Effort: **H/M/L**.

Re-scoped from 47 rows to 36: the mechanical chores (subpath export, `apiSurface` update,
tests, `types:generate`, `docs`, changeset) that were six separate rows per helper are now
folded into the parent task's notes; the examples task is folded into the pipelines task; the
two low-value deferrals are merged; and the frame-budget measurement task is closed into
GEO-045 now that §4.3 records its conclusion. GEO-016 and GEO-044, previously carried as
code candidates, are **rejected by the §1.1 scope test** — the first because MapLibre PR #8670
adds `preload: true` to core, the second because a fixed-timestep loop is not a geospatial
feature.

### Phase 0 — Measurement (must precede any implementation)

| Task ID | Status | Task                                                                                                                                                                                                                                                                                                                                      | Priority | ROI | Risk | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEO-001 | ✅     | Add `geoencode` mode to `bench/claims.js`: measure 4 arms (JSON stringify/parse round-trip; structured clone of the object graph; structured clone of a flat `Float64Array`; zero-copy transfer of that buffer) on two payload shapes — 200 LineStrings × 4,500 coords (MapLibre #106) and 1M points. Report bytes, ms, allocation count. | P0       | H   | L    | M      | **No longer gated on a helper** — GEO-005 is rejected, so this stands on its own as the answer to a question the ecosystem keeps guessing at. MapLibre #106 records geobuf tried and _"still takes ~200ms (same as before)"_; `web-worker-string-benchmark` measures direct string transfer beating an ArrayBuffer round-trip by 70–87% at 100 MB because `TextEncoder`/`TextDecoder` dominates. Publishing the result — **including a negative one** — is the contribution. Must run in a real worker (`bench/worker.js` pattern); a same-process `structuredClone()` is not the real call path. Seed the data; `AGENTS.md` records BENCH-001's unseeded `Math.random()` as a defect.                                                                                                                                                                                                                                                                                                                                        |
| GEO-002 | ✅     | Add `geocoalesce` mode to `bench/claims.js`: per-event update vs `PowerBatch` microtask flush vs a frame-aligned coalescer, **end-to-end** through a fake source that serialises, posts, parses and indexes.                                                                                                                              | P0       | H   | M    | M      | The premise for GEO-009. The `setImmediate`/608× lesson applies directly: per-turn cost is not batch cost, and a cheap stub produces a worthless number. **Must also report diff _quality_** — mutations coalesced, mutations dropped, drop policy honoured. MapLibre's `dataabort` event is the observable for the last.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| GEO-003 | ✅     | Add `geoprecision` mode to `bench/claims.js`: typed-array rounding pass vs object-shaped `turf.truncate` vs no pass, reporting output bytes and ms.                                                                                                                                                                                       | P1       | M   | L    | S      | The byte number is stable regardless of machine speed, which is why this mode is safe on a noisy host. turf is a bench-only comparison baseline and must not become a runtime dependency; if adding it to devDependencies is unacceptable, compare against a hand-written object-shaped baseline and say so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GEO-004 | ✅     | Mutation-check GEO-001/002/003: inject a deliberate defect (wrong arm, units error, no-op measurement) and confirm the bench reports the difference.                                                                                                                                                                                      | P0       | H   | L    | S      | `AGENTS.md`: "A guard that has never been observed failing is a hypothesis." The timing gate passed a deliberate 64% regression twice — once with no cache site to measure, once through a units error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GEO-049 | ✅     | Add `geoprefetch` mode to `bench/claims.js`: sweep the in-flight window (6 / 12 / 24) against a simulated per-tile latency, reporting requests issued, requests abandoned mid-flight, outstanding-at-arrival, and tiles that landed after the camera passed.                                                                              | P2       | M   | L    | M      | **Done, and the model needed two corrections before it measured anything.** (1) The first abandonment rule kept a request only if its tile was covered at `f` or `f + LEAD`, which dropped almost everything one frame after it was issued — 99.4% waste at every window, a number that looked like a finding and was a bug. (2) The `landed late` check looked _backwards_ from the landing frame instead of at the tile's last covering frame, reporting nearly everything as late. **The finding once correct:** the determinant is **lead vs latency, not the window**. With a 1002 ms lead against 600 ms tiles, no tile can land late and none can be abandoned at any window — the window controls only how far ahead you read (`issued` 30/60/96) and how much is in flight at arrival (`outstanding` 6/12/0). PR #8670's 23 abandoned at window 6 came from a real browser whose sampled and actual paths diverge; this model uses one path for both and cannot reproduce that term, which the mode says explicitly. |

### Phase 1 — Code

| Task ID | Status | Task                                                                                                                                                                                | Priority | ROI | Risk | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- | ---- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEO-039 | ✅     | Accept an injectable clock on the four helpers that genuinely lack one: `PowerDeadline`, `PowerCircuit`, `PowerCron`, `PowerEventLoopMonitor`. Default to the current module clock. | P1       | M   | M    | S      | **Corrected scope — four files, not ten.** `PowerTTLMap` and `cache/core` already accept `now` (both cite PERF-007 in their comments), and the four limiters accept it via `attachLimiterClock`. `PowerHeartbeat`, `PowerPool` and the socket clients read the clock through timer handles rather than deadline arithmetic, so an injected clock would not change their behaviour. **Must not regress the 141 ns `nowMs()` measurement that PERF-007 and RES-019 are built on** — store `this._now` once in the constructor and call it, which is one property lookup, not a threaded call.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| GEO-012 | ❌     | Ship a standalone coordinate-precision helper (`powerGeoPrecision`).                                                                                                                | —        | —   | —    | —      | **Rejected — the host owns this feature.** turf.js owns `truncate`; a typed-array variant is a _performance variant of a filled gap_, not a filled gap, and it makes the DX worse — a second truncate to choose between, with different duplicate-collapse and ring re-closing behaviour. Its only justification was callers of GEO-005, so the capability is **folded into GEO-005 as an encode-time option** (round while the encoder is already walking the buffer: nearly free, one export instead of two). The recipe GEO-020 carries the standalone 8-line function for a caller with coordinates in a typed array and no carrier. Full reasoning in §4.2.                                                                                                                                                                                                                                                                                                                                                 |
| GEO-009 | ❌     | Ship a generic time/frame-bounded coalescer (`powerCoalesce`).                                                                                                                      | —        | —   | —    | —      | **Rejected — measured, and the rejection condition fired.** GEO-002 swept the window at 1/2/4/16 ms: at every setting the coalescer is at best _equal_ to `PowerBatch` + a `Map` on work, and it always applies fewer mutations (1,716 vs 1,961 at a 16 ms window — a 12.5% fidelity loss, because a longer window collapses more under last-write-wins). `PowerBatch` alone already gives a 7.7x work reduction over per-mutation (37.5 -> 4.9 ms) and the `Map` adds a further 1.3x. **The honest composition wins and it is a recipe** — GEO-020 carries it. Note the harness history: the first draft consumed the stream in one synchronous loop and all three coalescing arms tied at one update each, which is the `setImmediate`/608x lesson reproduced. §10.4.                                                                                                                                                                                                                                          |
| GEO-005 | ❌     | Ship a columnar binary carrier for coordinate streams (`powerGeoColumns`).                                                                                                          | —        | —   | —    | —      | **Rejected — the transport already exists.** `powerMessageCodec` ships `CODECS.RAW`, which stores an `ArrayBuffer` or typed array _"verbatim, with no serialization at all"_, plus `isRawPayload()` for realm-independent detection and `collectTransferables(value, maxDepth)`, which walks an arbitrary object graph and returns every `ArrayBuffer` in it precisely so they can be transferred rather than copied. That is the whole transport half, already hardened against the cross-realm defect class twice (WRK-006, AUD-011). What was left was a struct-of-arrays _column store_ — a geo data structure, which this library said it would not build — and a _declared layout_, which is a convention worth five lines of JSDoc. There is also a consumer problem: MapLibre's `GeoJSONSource` takes GeoJSON or a URL and deck.gl has its own binary attribute layout, so our format would need an adapter on the far side in both cases. **The measurement survives as GEO-001**, ungated. §1.4, §4.1. |
| GEO-044 | ❌     | Ship a fixed-timestep game-loop helper (`powerFixedStep`).                                                                                                                          | —        | —   | —    | —      | **Rejected — out of scope.** Not a geospatial feature, not a gap maplibre or turf leaves, and not one this library is unusually placed to fill: the pattern is ~50 lines with many existing implementations. It may belong on the _general_ roadmap as a scheduling primitive, but it does not belong in a geo proposal. An earlier revision listed it as a candidate with a rejection condition; the scope test in §1.1 settles it outright.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GEO-016 | ❌     | Ship a camera-movement prefetch helper (`powerGeoPrefetch`).                                                                                                                        | —        | —   | —    | —      | **Rejected — the host owns this feature.** MapLibre PR #8670 adds `preload: true` to core, sampling the movement's own path and requesting tiles through a priority cursor bounded by an in-flight window. Duplicating that is the definition of "building an owned maplibre feature". **The recipe survives as GEO-048**, scoped to where core prefetch does not reach: custom sources registered through `addSourceType`, and deck.gl layers. Note the history — this task was deleted, then restored after UC4 showed the priority policy was more than "five lines of arithmetic", then rejected again once the scope test was applied. The final answer is recipe, not helper.                                                                                                                                                                                                                                                                                                                              |

### Phase 2 — Documentation (the highest-ROI phase)

| Task ID | Status | Task                                                                                                                                                                                                                                            | Priority | ROI | Risk | Effort | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEO-014 | ✅     | `guides/geo.md` — the router: "I have a map / a tile pipeline / a realtime feed, what do I reach for."                                                                                                                                          | P0       | H   | L    | M      | Highest-ROI item in the plan. Model on `guides/metaGuide.md`. Must include a "when this library is the wrong half" section — the meta guide has one and it is the most useful part of it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GEO-046 | ✅     | The four use-case pipelines from §6, end to end, with the helper wiring and the numbers each stage must hit; plus a "when this helper is the wrong choice" section.                                                                             | P0       | H   | L    | M      | **Absorbs the former GEO-047 and GEO-023.** The pipelines are the artefact that makes the library legible to a geospatial developer, and each names the gap it exposes so a reader can see which candidates are load-bearing. The "wrong choice" section must cover at minimum: do not put GEO-009 on an input path (UC3); do not read live simulation state from the render thread (UC2); do not coalesce across a frame boundary when the consumer is a game. Runnable `examples/geo-*.mjs` wired into `scripts/run-example.mjs` and covered by `test/examples.test.js` belong here.                                                                                                                                                                                                    |
| GEO-022 | ✅     | `guides/metaGuide.md` — add a "Geospatial" section under "Pick by domain" and 4–6 quick-chooser rows.                                                                                                                                           | P0       | H   | L    | S      | Check for duplicated or contradictory sections afterwards — the file carried two "Realtime: framing" sections, one a truncated copy of the other.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GEO-024 | ✅     | `adr/0015-geospatial-scope.md` — record what this library will and will not do for geospatial, with the §7 rejections and their reasons.                                                                                                        | P0       | H   | L    | S      | A rejected decision is still worth recording, because the next person should find the measurement that killed it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| GEO-025 | ✅     | Fold this file's decisions into `adr/0015` and `guides/geo.md`, then delete or reduce `geo-helpers.md` to a pointer.                                                                                                                            | P1       | M   | L    | S      | **Done.** The decisions now live in `adr/0015-geospatial-scope.md` (the scope test, the three measurement tables, the adopted item, and all sixteen rejections with reasons) and the reference material in `guides/geo.md`. This file is retained rather than deleted, because it carries the _reasoning trail_ the ADR deliberately compresses: the four use cases worked end to end, the two candidates that were rehabilitated and then re-rejected, and the two scope corrections made by reading source rather than guessing. It is marked as superseded below so it cannot be mistaken for a second source of truth.                                                                                                                                                                |
| GEO-015 | ✅     | Recipe: Node-side geometry/tile pipeline with `PowerPool` + `PowerChunker` + `PowerCache` + `PowerQueue`.                                                                                                                                       | P1       | H   | L    | S      | GAP-8. No new code. **Absorbs the former GEO-042** — the `setWorkerCount`/`setWorkerUrl`/`prewarm` ordering trap belongs in the same recipe: wrong order silently yields a single-worker map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| GEO-019 | ✅     | Recipe: realtime feed ingestion (AIS / vehicle / IoT) with `PowerTTLMap` + `PowerDeduplication` + `PowerSequencer` + `PowerHeartbeat` + `PowerRealtimeHub`.                                                                                     | P1       | H   | L    | S      | GAP-6. The composition is complete; only the documentation is missing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| GEO-020 | ✅     | Recipe: deck.gl binary attributes produced in a worker and transferred zero-copy.                                                                                                                                                               | P1       | H   | L    | S      | GAP-1's consumer side. Name `GeoJSONSourceDiff` as the target shape for the MapLibre path and `data.attributes` for the deck.gl path — different consumers of the same buffer. **Absorbs the former GEO-040** — bounding in-flight tile requests inside an `addProtocol` handler with `PowerSemaphore`/`PowerBulkhead`, and pacing with `PowerThrottle`/`PowerGCRA` (F3). Uses `CODECS.RAW` plus `collectTransferables()` for the transfer — no new codec — and a hand-rolled `Float32Array` for the columns, and says so. **Also carries the folded GEO-012 capability as a recipe**: the 8-line rounding function for a caller who already holds coordinates in a typed array, with a pointer at `turf.truncate` for everyone else. No helper, no second export, no competing truncate. |
| GEO-041 | ✅     | Recipe: the `updateData` vs `setData` decision rule, with the crossover stated.                                                                                                                                                                 | P1       | H   | L    | S      | `GeoJSONVTOptions.updateable` carries a documented caveat ("with caveat of a stored simplified copy"), and MapLibre #7336 measures the incremental index update at ~7.5× _slower_ than a full rebuild when all features are touched. Rule of thumb to verify: `updateData` when the diff touches a small fraction of features, `setData` otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| GEO-045 | ✅     | Recipe: the frame-budget stack — `PowerApdex {target: 16.7}` for attainment, `PowerEventLoopMonitor` for host-vs-app attribution, `PowerDeadline` for a hard per-frame cap, `PowerBrownout` for shedding in a declared order.                   | P1       | H   | L    | S      | **Closes the former GEO-018**, whose conclusion §4.3 now records: `PowerApdex` is the sound instrument because `PowerHistogram.countAtOrBelow()` is unsound at the threshold. The W3C Frame Timing spec states the 16.6 ms budget and the consequence of exceeding it; nothing here composes the four helpers that address it. No new code — the deliverable is the composition and the shedding order.                                                                                                                                                                                                                                                                                                                                                                                   |
| GEO-048 | ✅     | Recipe: camera-movement prefetch for **custom sources and deck.gl layers** — sample the movement's path, read it destination-first, and drive a `PowerPriorityQueue` cursor bounded by a `PowerBulkhead` window shared equally between sources. | P2       | M   | L    | M      | **New, from UC4 (§6.5), and the surviving half of the rejected GEO-016.** Must state plainly what it cannot reach: §5.5 lists the four hooks MapLibre lacks (private `Tile` class, off-screen cache creation, public animation paths, a per-frame render event), so a third party works through `addProtocol` + `addSourceType` and the public `Camera` API only. **Scoped to where core `preload` does not reach** — if PR #8670 merges, built-in sources are covered by core and this recipe's value is custom sources and deck.gl layers, which is a narrower but real gap. Must carry the arrival/interruption asymmetry as a declared policy, and the sub-second-movement regression (65% → 59% in-flight coverage) as a known limitation.                                           |

### Resolved by deletion

| Task ID | Status | Task                                                             | Priority | ROI | Risk | Effort | Notes                                                                                                                                                                                           |
| ------- | ------ | ---------------------------------------------------------------- | -------- | --- | ---- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEO-017 | ➖     | ~~`PowerGeoIndexCache`~~ — spatial-index lifecycle and transfer. | P2       | M   | L    | S      | **Resolved by deletion.** flatbush/kdbush already expose `index.data` as a transferable `ArrayBuffer` by design; `PowerCache` + `powerMessageCodec` `RAW` cover versioning and transfer. GAP-4. |

### Rejected / won't do

| Task ID | Status | Task                                                                         | Priority | ROI | Risk | Effort | Notes                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------ | ---------------------------------------------------------------------------- | -------- | --- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GEO-026 | ❌     | Reimplement turf.js spatial analysis (distance, area, buffer, intersection). | —        | —   | —    | —      | **Rejected.** turf.js is 10.4k stars, MIT, modular. `buffer` delegates to JSTS, which cannot be vendored under the zero-dependency rule (`REJ-008`). No measured premise.                                                                                                                                                                  |
| GEO-027 | ❌     | Ship a spatial index (R-tree / KD-tree / packed Hilbert R-tree).             | —        | —   | —    | —      | **Rejected.** flatbush indexes 1M rectangles in 109 ms; kdbush is 5–8× faster than rbush at indexing. We would lose.                                                                                                                                                                                                                       |
| GEO-028 | ❌     | Ship point clustering.                                                       | —        | —   | —    | —      | **Rejected.** supercluster is the reference, is embedded in MapLibre, and clusters 6M points in a browser.                                                                                                                                                                                                                                 |
| GEO-029 | ❌     | Ship an MVT / PBF encoder.                                                   | —        | —   | —    | —      | **Rejected.** vt-pbf and @maplibre/vt-pbf exist. Spec compliance, not performance.                                                                                                                                                                                                                                                         |
| GEO-030 | ❌     | Ship projection / reprojection math.                                         | —        | —   | —    | —      | **Rejected.** math.gl / proj4 / MapLibre internals own it. Subtle correctness surface (antimeridian, poles), no measured performance premise.                                                                                                                                                                                              |
| GEO-031 | ❌     | Ship H3 / S2 / geohash encoding.                                             | —        | —   | —    | —      | **Rejected.** h3-js exists; the integer-vs-string tradeoff is documented. The win is key _shape_, which `PowerCache` already accepts.                                                                                                                                                                                                      |
| GEO-032 | ❌     | Ship a faster GeoJSON parser.                                                | —        | —   | —    | —      | **Rejected.** `JSON.parse` is native. The win is in not parsing (GAP-1), not in parsing faster.                                                                                                                                                                                                                                            |
| GEO-033 | ❌     | Ship a `PowerMap` / map-engine abstraction.                                  | —        | —   | —    | —      | **Rejected.** That is a rendering engine, not a helper. Out of scope by the library's own definition.                                                                                                                                                                                                                                      |
| GEO-034 | ❌     | Add payload compression for geo payloads.                                    | —        | —   | —    | —      | **Rejected — already measured.** `bench/claims.js payload` settles "why compression does not pay in-process". Do not re-litigate.                                                                                                                                                                                                          |
| GEO-035 | ❌     | Add a `SharedArrayBuffer` permit pool for geo.                               | —        | —   | —    | —      | **Rejected — already measured.** `bench/claims.js permit` takes the same dispatch decision two ways — a plain field read (`tasks < this._maxTasksPerWorker`, which is what `PowerPool` already does) and an `Atomics.load` — and `AGENTS.md` records the atomic at **6.4× more expensive**. The premise was inverted, not merely unproven. |
| GEO-036 | ❌     | Add a structured-clone-to-bytes codec.                                       | —        | —   | —    | —      | **Rejected — already recorded.** `powerMessageCodec`'s JSDoc: the structured-clone algorithm does not produce bytes, and serialising it needs a serialization library.                                                                                                                                                                     |
| GEO-043 | ❌     | Build on `importScriptInWorkers()` to load our code into MapLibre's workers. | —        | —   | —    | —      | **Rejected.** Documented as _"using some very internal classes and flows … considered experimental and can break at any point."_ A geo story built on it breaks on a MapLibre minor. Use the stable `addProtocol` + `addSourceType` surface instead.                                                                                       |

### Deferred

| Task ID | Status | Task                                                                                                          | Priority | ROI | Risk | Effort | Notes                                                                                                                                                                                                                                  |
| ------- | ------ | ------------------------------------------------------------------------------------------------------------- | -------- | --- | ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEO-037 | ⏰     | Revisit a deck.gl-specific adapter, and a dedicated frame-budget helper, once `guides/geo.md` has real users. | P3       | L   | L    | S      | **Deferred.** Merges the former GEO-037 and GEO-038. An adapter written before there is demand is speculation about an API we do not control, and a frame-budget helper would be solving a problem `PowerApdex` already solves (§4.3). |

---

**Delivery note.** GEO-015, GEO-019, GEO-020, GEO-041, GEO-045, GEO-046 and GEO-048 were
delivered as **sections of `guides/geo.md`** rather than as separate files. The guide already
had to exist for GEO-014, and splitting each recipe into its own file would have added
navigation cost for material that is read once and in sequence. The sections are: "Moving a
large coordinate array to a worker" (GEO-020), "Reducing payload size" (GEO-041),
"Expiring entities that stopped reporting" (GEO-019), "Bounding tile requests" (GEO-040,
folded), "The frame-budget stack" (GEO-045), "A Node-side geometry or tile pipeline"
(GEO-015), and "Camera-movement prefetch over a slow network" (GEO-048). The four use-case
pipelines are GEO-046.

---

> **SUPERSEDED.** The decisions in this document now live in
> [`adr/0015-geospatial-scope.md`](adr/0015-geospatial-scope.md) and the reference material
> in [`guides/geo.md`](guides/geo.md). This file is retained only for its reasoning trail —
> the four use cases worked end to end, the candidates that were rehabilitated and then
> re-rejected, and the two scope corrections made by reading source rather than guessing.
> It is not a source of truth. GEO-025.

---

## 10. Measurement plan detail

The three new `bench/claims.js` modes, specified tightly enough that the result means
something.

### 10.1 `geoencode` (GEO-001)

**Payloads.** _Lines:_ 200 `LineString` features × 4,500 coordinates — the exact shape from
MapLibre #106, so the result is comparable to the reported 200 ms. _Points:_ 1,000,000
positions — the shape deck.gl and supercluster are built for.

**Arms.** (1) `JSON.stringify(fc)` → `postMessage(string)` → `JSON.parse` in the worker.
(2) `postMessage(fc)` — structured clone of the object graph. (3) `postMessage(flatFloat64)` —
structured clone of one flat buffer. (4) `postMessage(flatFloat64, [flatFloat64.buffer])` —
zero-copy transfer.

**Reported.** bytes on the wire, wall-clock ms for the round trip, and peak allocation where
obtainable. Arms 1 and 2 are expected to differ by roughly the cost of one extra copy; arms 2
and 4 are the pair the ecosystem keeps guessing at. **No helper is gated on the result** —
GEO-005 is rejected — so a negative answer is a publishable finding rather than a deleted task.

**Must run in a real worker.** `bench/worker.js` already establishes the pattern
(`globalThis.Worker = NodeWorker`). A same-process `structuredClone()` is not the real call
path and would flatter arm 4. **Must be seeded** — `AGENTS.md` records BENCH-001's unseeded
`Math.random()` as a defect. Use a deterministic PRNG.

### 10.2 `geocoalesce` (GEO-002)

**The fake source must do the real work.** Serialise the diff, post it, parse it, apply it to
a `Map` keyed by feature id, and mark affected tiles dirty. A stub that just counts calls will
show a 600× win that does not exist end to end.

**Arms.** (1) One update per mutation, no coalescing. (2) `PowerBatch` with a microtask flush.
(3) `PowerBatch` plus a `Map` for the keyed last-write-wins merge — **the honest composition, and
the one the candidate has to beat**. (4) A time/frame-aligned coalescer (the candidate).

**Reported.** updates delivered per second, mutations dropped, p99 end-to-end latency from
mutation to visible state, and **whether the drop policy was the declared one**. **Drops must
be reported, not hidden** — a coalescer that wins on throughput by silently discarding half
the mutations has not won.

### 10.3 `geoprecision` (GEO-003)

**Arms.** no pass; typed-array rounding pass; object-shaped `turf.truncate`.

**Reported.** output bytes, ms, and the number of duplicate positions collapsed. The byte
number is the one that matters and it is stable regardless of machine speed, which is why this
mode is safe to run on a noisy host.

### 10.4 Results as measured (2026-10-10)

All three modes run clean under `npx eslint`, on Node 24, with the defaults above
unless a cell says otherwise. These are **our** numbers, not third-party ones.

#### GEO-001 — `geoencode`

| payload          | stringify     | arm1 json | arm2 clone | arm3 clone | arm4 xfer | 4 vs 2     |
| ---------------- | ------------- | --------- | ---------- | ---------- | --------- | ---------- |
| 200 lines x 4500 | **196.69 ms** | 296.91    | 393.75     | 1.66       | 8.35      | **47.2x**  |
| 200k points      | 25.17 ms      | 56.95     | 103.96     | 0.64       | 0.45      | **232.4x** |

`arm1` includes the main-thread stringify; `arm4` includes building the buffer.
Bytes on the wire: lines 34.4M json vs 13.7M flat (2.50x); points 7.2M vs 0.8M
(9.38x).

**Five findings, and the first one validates the harness.**

1. **The stringify measurement independently confirms MapLibre #106.** The issue
   reports _"about 200ms"_ for `JSON.stringify` on exactly this payload shape;
   this harness measures **196.69 ms** on the same shape. That the harness
   reproduces a number reported by someone else, on a different machine, on a
   different V8, is the strongest available evidence that it models the real
   call path rather than a synthetic one.
2. **Structured clone of the object graph is _slower_ than JSON.** arm2 (393.75
   ms) beats arm1 (296.91 ms) in the wrong direction — cloning a
   `FeatureCollection` costs more than stringifying and parsing it. So the
   obvious "just `postMessage` the object" answer is _worse_ than what MapLibre
   already does. This is not the intuitive result and it is worth pinning.
3. **A flat buffer is 47x faster than the object graph** on the #106 shape and
   232x on points. The object-graph penalty is the dominant cost by two orders
   of magnitude.
4. **The win is flattening, not transferring.** arm3 (structured clone of the
   flat buffer, 1.66 ms) is within timer resolution of arm4 (zero-copy transfer,
   ~1.3 ms after subtracting the 7.06 ms build). Chrome's ~46x transfer figure
   does not reproduce here at this size, because the clone of a _flat_ buffer is
   already cheap. **The lesson: stop building an object graph; the transfer mode
   is a second-order optimisation on top of that.**
5. **A negative result on the transfer question is a publishable finding.** The
   ecosystem's instinct is "binary + transfer = fast"; the measurement says
   "flatten = fast, transfer = marginal". That is exactly the kind of retracted
   claim this project's changelog is built on.

**What it means for the plan.** GEO-005 stays rejected — the transport already
ships — but the measurement now gives the GEO-020 recipe a number it can cite
instead of an assertion, and it says the recipe's headline should be _flatten
first_, not _transfer first_.

#### GEO-002 — `geocoalesce`

2000 entities at 1 Hz for 1 s = 2,000 mutations over 60 frames (33 per frame,
1 ms apart). `work ms` subtracts the frame delay, which is charged to every arm
equally.

| arm             | work ms | updates | applied |
| --------------- | ------- | ------- | ------- |
| per-mutation    | 37.5    | 2000    | 1,980   |
| PowerBatch      | 4.9     | 60      | 1,980   |
| **Batch + Map** | **3.8** | 60      | 1,961   |
| coalescer 16ms  | 7.7     | 3       | 1,325   |

Window sweep, coalescer work ms / updates / applied:

| window | work ms | updates | applied |
| ------ | ------- | ------- | ------- |
| 1 ms   | 6.4     | 59      | 1,928   |
| 2 ms   | 10.8    | 31      | 1,948   |
| 4 ms   | 5.1     | 16      | 1,917   |
| 16 ms  | 8.1     | 5       | 1,716   |

**The rejection condition has fired.** At every window the coalescer is at best
equal to `PowerBatch` + a `Map` on work, and it _always_ applies fewer mutations
— 1,716 against 1,961 at a 16 ms window, a 12.5% fidelity loss, because a longer
window collapses more mutations under last-write-wins. Fewer applied is not free:
it means staler positions on screen.

**GEO-009 is therefore rejected.** The honest composition wins, and it is a
recipe. `PowerBatch` alone already delivers a 7.7x work reduction over
per-mutation (37.5 -> 4.9 ms); adding a `Map` for the keyed merge delivers a
further 1.3x. Nothing else is needed.

**A note on the harness, because it nearly measured nothing.** The first draft
consumed the stream in one synchronous `for` loop, so every mutation arrived in
the same event-loop turn: `PowerBatch` flushed once, the coalescer's window fired
once, and all three coalescing arms tied at one update each. That is the
`setImmediate`/608x lesson in `AGENTS.md` reproduced almost verbatim by a harness
that looked reasonable. Mutations now arrive in per-frame batches with a real
delay between frames, and `CLAIM_COALESCE_FRAME_MS=0` uses `setImmediate` so the
loop still turns without charging every arm the same artificial wait.

#### GEO-003 — `geoprecision`

Saving against the unrounded payload:

| payload          | repr | 15d   | 7d     | 6d         | 5d     | 4d     | 3d     |
| ---------------- | ---- | ----- | ------ | ---------- | ------ | ------ | ------ |
| 200 lines x 4500 | json | -0.1% | -35.6% | **-40.6%** | -45.6% | -50.6% | -55.6% |
| 200 lines x 4500 | flat | -0.0% | -0.0%  | **-0.0%**  | -0.0%  | -0.0%  | -0.0%  |
| 200k points      | json | -0.0% | -9.5%  | **-10.8%** | -12.2% | -13.5% | -14.8% |
| 200k points      | flat | -0.0% | -0.0%  | **-0.0%**  | -0.0%  | -0.0%  | -0.0%  |

**The finding is in the flat column, and it is zero.** A `Float64Array` is 8 bytes
per coordinate whatever the value, so rounding does not shrink it at all. The
saving is entirely on the JSON side, and it is _shape-dependent_: 40.6% on
line-heavy data, only 10.8% on point-heavy data.

So MapLibre's "reduce coordinate precision" advice is worth 40% on a
line-heavy dataset and 11% on a point-heavy one, and nothing at all once you have
flattened. That is the whole argument for the GEO-020 recipe being about _which
representation you choose_ rather than about a rounding helper — which is the
conclusion GEO-012's rejection already reached, now with a number behind it.

A `Float32Array` column would be 4 bytes per coordinate regardless of precision,
and loses precision beyond ~6 decimals — exactly the RFC 7946 recommendation, so
the loss is acceptable but must be stated rather than discovered.

### 10.5 `geoprefetch` (GEO-049)

**What it measures.** The in-flight window for a camera-movement prefetch, against a
simulated per-tile latency.

**Arms.** window 6, 12, 24, and a value derived from an injected connection limit (the host's
own, where discoverable). PR #8670 measures 12 as optimal against Chromium's ~6 connections
per origin; that ratio is host-dependent and must not be hard-coded.

**Reported.** requests issued, requests abandoned mid-flight, and outstanding-at-arrival. All
three matter: a window that is too small puts the churn back (23 abandoned at window 6
against 0 at 12), and one that is too large holds requests that queue behind the render
loop's (18 outstanding at arrival at window 24 against 6 at 12).

**Harness note.** `test/bench/e2e/preload_flight.mjs` is the reference implementation but is
browser-only, because it discovers the connection limit from the browser. A Node port must
have the limit **injected** rather than discovered, and the mode must say so — otherwise it
measures a constant against a guess.

---

## 11. Risks

| Risk                                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GEO-001 shows the object graph is already cheap in modern V8, and the carrier is unnecessary | M          | M      | The negative result is still worth publishing. This project's changelog is built on retracted claims and treats them as assets.                                                                                                                                                                   |
| GEO-002 shows `PowerBatch` ties, and the coalescer is unnecessary                            | M          | M      | Ship the recipe. Delete GEO-009 rather than shipping a helper that ties.                                                                                                                                                                                                                          |
| GEO-044 shows `PowerScheduler` + a caller accumulator ties                                   | **H**      | L      | Delete it. This is the expected outcome and the rejection condition is written down in advance.                                                                                                                                                                                                   |
| Scope creep: one geo helper becomes a GIS toolkit                                            | **H**      | **H**  | GEO-024 (the ADR) exists specifically to be the document someone points at. §7 is its content.                                                                                                                                                                                                    |
| The zero-dependency rule is pressured by a geo algorithm that "needs" JSTS or proj4          | M          | H      | Every rejection in §7 cites this. turf's own `buffer` delegating to JSTS is the concrete example.                                                                                                                                                                                                 |
| A geo helper adds an `await` to a hot synchronous path                                       | M          | M      | No candidate now requires an async encode path, but the rule stands for any future one. Enforce in review.                                                                                                                                                                                        |
| Cross-realm `ArrayBuffer` checks done with `instanceof`                                      | M          | H      | `AGENTS.md` records three defects in this class, two in code already fixed for it — and `powerMessageCodec` was fixed for it twice (WRK-006, AUD-011). Any future codec work must use a real `node:vm` fixture, not a hand-rolled `{ byteLength: n }` stand-in, which `new Uint8Array()` accepts. |
| GEO-039 regresses the 141 ns `nowMs()` hot path                                              | L          | M      | Store `this._now` once in the constructor and call it — one property lookup, the same shape `PowerTTLMap` and `cache/core` already use. `PERF-007` and `RES-019` are the measurements to protect.                                                                                                 |
| `types/` and `docs/` drift after a JSDoc edit                                                | **H**      | M      | The chores are folded into each code task's notes. Regenerate **before** staging; `docs:drift` compares against the index, not `HEAD`.                                                                                                                                                            |
| A benchmark passes for the wrong reason (no measurement site, units error)                   | M          | H      | GEO-004 is a mandatory mutation check, not optional.                                                                                                                                                                                                                                              |
| The document itself becomes a second source of truth                                         | M          | L      | GEO-025 folds it into the ADR and the guide, then removes it.                                                                                                                                                                                                                                     |

---

## 12. Open questions

1. **Does `turf` belong in `devDependencies` for GEO-003?** It is a comparison baseline, not a
   dependency, but adding it to `package.json` at all needs a conscious decision. The
   alternative is a hand-written object-shaped baseline — weaker evidence, touches nothing.
2. **Is a `layout` option on `CODECS.RAW` worth adding?** It would let `decodeInbound`
   reconstitute declared columns instead of the caller interpreting a bare buffer. It is a
   small, additive change to a shipped helper — but it is speculative until GEO-001 and real
   usage show anyone needs it. Leaning no: ship the recipe first, add the option only if asked.
3. **Is a frame-aligned clock portable?** `requestAnimationFrame` is browser-only. In Node the
   closest equivalent is `PowerScheduler`'s one-flush-per-turn. If GEO-009 is built, the clock
   must be injectable and the Node behaviour documented rather than silently degraded.
4. **What is the fidelity contract for a `Float32Array` column?** deck.gl's own guidance is
   that positions can be float32 or float64 "depending on precision requirements". A
   `Float32Array` lon/lat column loses precision beyond ~6 decimal places, which is exactly the
   RFC 7946 recommendation — so the loss is _acceptable_ but must be stated, the way
   `powerMessageCodec` states that a `Map` arrives as `{}`.
5. **Does GEO-039 need a `now` option on `PowerCircuit` specifically, or is a module-level
   injectable clock enough?** `PowerCircuit` is the one helper with no injection point at all,
   and `src/utils/now.js` documents that a faked `Date.now()` was never a documented way in for
   it. Adding a constructor `now` is the smaller change; a module-level setter is the more
   useful one and the more dangerous.

---

## 13. Sources

**MapLibre GL JS** — issue #106 (_GeoJSON Source `setData` can take surprisingly long_: 200 ms
`JSON.stringify`, 5 updates/s, geobuf no faster); #4364 (2,278 shapes; update is not
incremental); #6667 (_Optimize GeoJSON Data Transfer_: full dataset returned to main thread;
`getStyle()` behaviour); #7336 (diff update ~7.5× slower in 5.20.2 vs 5.19.0 when all features
are touched); #1236 (the original diff-API design); discussion #5992 (1 feature/s → 30–50
renders/s); guide _Optimising MapLibre Performance: Tips for Large GeoJSON Datasets_; example
_Display Map Performance Metrics_; API `setWorkerCount`/`getWorkerCount` (default 1; half cores
capped at 3 on Safari), `setMaxParallelImageRequests` (default 16, images only), `prewarm`,
`importScriptInWorkers` (experimental), `addProtocol`/`AddProtocolAction`, `addSourceType`,
`GeoJSONSource`, `GeoJSONSourceDiff`, `GeoJSONFeatureDiff`, `GeoJSONWorkerSource`,
`GeoJSONWorkerOptions`, `LoadGeoJSONParameters`, `Dispatcher`, `IActor`, `getGlobalDispatcher`,
`now`/`setNow`/`isTimeFrozen`/`restoreNow`, `createTileMesh`, `EXTENT`, `Source`,
`CustomLayerInterface`, `MapEventType`, `MapOptions`, `RequestParameters`,
`GetResourceResponse`, `MessageType`, `ActorMessage`, `OverscaledTileID`, `Tile`,
`FeatureIndex`, `VectorTileSource`; source `src/source/geojson_source.ts`,
`src/source/geojson_source_diff.ts`, `src/source/geojson_worker_source.ts`,
`src/source/worker.ts`, `src/index.ts`, `src/util/actor.ts`, `src/util/dispatcher.ts`;
v5→v6 migration guide and CHANGELOG (ESM-only, WebGL2 required, `zoomLevelsToOverscale`
default 4, `setMissingStyleImageResolver`, `__$json__` nested-object encoding)

**MapLibre style spec** — `sources.geojson` options (`buffer` default 128 range 0–512,
`tolerance` default 0.375, `cluster`, `clusterRadius`, `clusterMaxZoom`, `clusterMinPoints`,
`clusterProperties`, `lineMetrics`, `generateId`, `promoteId`, `filter`, `maxzoom`)

**@maplibre/geojson-vt** — `GeoJSONVTOptions` (`buffer` 64, `extent` 4096, `maxZoom` 14,
`indexMaxZoom` 5, `indexMaxPoints` 100000, `tolerance` 3, `promoteId`, `generateId`,
`lineMetrics`, `updateable`, `cluster`, `clusterOptions`, `debug`)

**deck.gl** — developer guide _Performance Optimization_ (accessors are 99% of buffer-update
CPU; chunked loading; binary attributes; worker-side attribute generation; memory pressure on
phones; 1 GB allocation cap); `Layer.data`, `updateTriggers`, `AttributeManager`; _What's New_
(TileLayer viewport-centre prioritisation; MVT parsing 2–3× faster via binary attributes;
`MVTLayer { binary: true }`); aggregation layers CPU-vs-GPU measured table (25K / 100K / 1M);
`@deck.gl/maplibre` `MapLibreOverlay` (overlaid and interleaved modes, WebGL2 requirement)

**turf.js** — repository, modular `@turf/*` packages, `truncate`, `buffer` → JSTS delegation

**Spatial indexes** — flatbush (packed Hilbert R-tree, `index.data` transferable, M1 Pro /
Node 24 bench), kdbush (5–8× faster indexing than rbush, ~2× less memory than flatbush),
rbush, geojson-rbush

**Formats and servers** — FlatGeobuf (Denmark OSM benchmark: GeoJSON 15× read, 705× filtered),
geobuf, vt-pbf / @maplibre/vt-pbf, PMTiles, MBTiles; tileserver-rs benchmarks (PMTiles 1,355
req/s vs MBTiles 759; z14 1,496 vs 239), martin, tippecanoe

**Specifications and standards** — RFC 7946 (coordinate precision, ~2× inflation 6→15
decimals); GDAL RFC 99 (coordinate precision, 16 LSB zeroable at 1 mm, 13% zip reduction);
Mapbox Vector Tile specification 2.1; W3C Frame Timing specification (_"16.6ms for 60Hz
refresh rate"_; exceeding it means _"one or more frames is skipped"_)

**Grids** — H3 documentation (vs S2, vs geohash; integer vs string indexes); CARTO spatial
indexes

**Realtime feeds** — aisstream.io (message dropping under slow consumption;
permessage-deflate advice); AISHub API (1 req/min limit)

**Comparative study** — ICA-ABS 10-14-2025, _Comparative performance analysis of open source
web mapping libraries_ (Leaflet / OpenLayers / Mapbox GL JS / MapLibre GL JS)

**Web platform** — Chrome for Developers, _Transferable objects — Lightning fast_ (32 MB: 302 ms
clone vs 6.6 ms transfer); MDN, _Transferable objects_ and _The structured clone algorithm_;
`mlightcad/web-worker-string-benchmark` (100 MB: direct string 211 ms vs ArrayBuffer round-trip
693 ms; Unicode 202 ms vs 1,530 ms)

**Use-case evidence** — Placematic fleet-dashboard case study (200 trucks × 10 s = 648,000
packets/day; 1,000 trucks × 5 s = 6.5M/day; _"GPS volume is the quiet problem. Anything
per-point multiplies by fleet size × ping rate"_); a published fleet-management case study
(5,000+ vehicles; _"the UI became sluggish when rendering more than 500 vehicles
simultaneously"_; solved with WebGL layers and clustering); TRAVIC transit-visualisation demo
paper (many thousands of vehicles in real time; lower refresh rates at lower zoom levels); AWS
sample automated fleet tracker (MapLibre GL JS + WebSocket; _"time since last update"_ per
vehicle); RepliCore, _Reproducible Parallel Simulation under Asynchronous Browser Runtimes_
(logical time `t_k = k·Δt`; state updates only at explicit step boundaries; partitioned state
across workers; _"all configurations produced bitwise-identical states across runs"_ under
1/2/4/8/16 workers and 60/30/10 FPS); CrowdFlow (60 Hz fixed-timestep physics; spatial hash
O(n) neighbor lookups; zero-allocation hot loops; _"UI polls stats at 10fps — never re-renders
for simulation state"_); CrowdSim (10,000 → 100,000+ agents); position-based-dynamics crowd
simulation (~100k agents at interactive rates); a WebGPU boids implementation (10,000+ agents
at 60 FPS)

**Camera-movement prefetch (UC4)** — MapLibre GL JS PR
[#8670](https://github.com/maplibre/maplibre-gl-js/pull/8670), _"Add a `preload` option to
animated camera movements"_ (AbelVM, open, 8 commits), and its predecessor plugin
[`AbelVM/maplibre-preload`](https://github.com/AbelVM/maplibre-preload). Measured in real
Chrome by `test/bench/e2e/preload_flight.mjs` (local tile server with a per-tile delay, cold
origin, two sources; the measure is the share of the **frame drawn** at arrival, not the share
of tiles): 3 s NYC→Tokyo z11 at 400/600/800 ms per tile goes from 0%/13%/0% of the viewport
drawn to 100%/70%/67%, with requests falling 112→48, 97→36, 100→26; a pitched 3 s flight at
600 ms goes from 16% to 92% of the frame; abandoned requests fall from 82 of ~100 to zero.
Design decisions, each forced by a measurement: destination-first ordering (camera order
brought _not one_ destination tile in before arrival and landed the destination 20–770 ms
_later_ than no preload); read ahead by one second's worth of samples floored at two (two
samples = 1.26 s of warning on a 10 s flight but ~50 ms on a 1 s one);
`MAX_TILES_IN_FLIGHT = 12` shared equally between sources, optimal of 6/12/24 against
Chromium's ~6 connections per origin (window 6 → 53 requests / 23 abandoned / 6 outstanding;
12 → 36 / 0 / 6; 24 → 46 / 5 / 18); a drained queue is room for more, not a finished preload;
`MAX_FRAME_COUNT` 16→48 tried and rejected (trip coverage 50% vs 53%); `tileDistanceToCamera`
vs `distanceSq` a tie (92%/92% mercator, 87%/85% globe). Arrival-vs-interruption split settled
on user experience: keeping requests on interruption costs 14.7% of viewport recovery (4533 ms
vs a 3951 ms baseline), and before the split _"every gesture interrupting a flight held its
requests and paid the full 580 ms."_ Cost: 0.59 ms per movement (p99 1.57 ms, from 2.50 ms /
4.53 ms); bundle +4,925 bytes raw, +1,512 gzip, over the 256-byte quota. Known limitations
stated by the author: sub-second movements dip in-flight coverage 65%→59%; a tail of requests
for ground behind; no preloading before a movement is committed; at pitch not every
destination tile arrives (42 tiles covered, ~40 fetches affordable). Maintainer discussion
records the four extension points MapLibre lacks — private `Tile` class, off-screen cache
creation, public animation paths, a per-frame render event — and a collaborator's counter-
proposal of _"a minimal set of public API … like the addition of covering tiles."_

**Fixed-timestep and frame-budget references** — Gaffer on Games, _Fix Your Timestep!_
(accumulator, while-loop, interpolation `alpha`, clamping against the spiral of death);
_game-mechanics-optimizations_ fixed-timestep notes (variable-timestep failure modes:
numerical instability, tunneling, non-determinism; fixed timestep is _"100% deterministic"_;
memory cost _"current + previous state for interpolation (+16-64 bytes per object)"_); a
published TypeScript fixed-timestep loop (injectable clock and scheduler, `maxUpdates` catch-up
cap, 0.25 s frame-time clamp, `{fps, ups, avgFrameTime}` metrics); Unity Input System timing
guidance (dynamic vs fixed update for input latency)

**This repository** — `AGENTS.md`, `README.md`, `guides/metaGuide.md`, `src/index.js`,
`src/helpers/*.js` JSDoc, `src/utils/now.js`, `src/utils/limiterClock.js`, `bench/claims.js`,
`bench/baseline.js`, `scripts/verify.mjs`, `adr/0001`–`0014`, `test/apiSurface.test.js`

---

_End of analysis. No source, test, benchmark, guide, ADR or changeset files were modified in
producing this document._
