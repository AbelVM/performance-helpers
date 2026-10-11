# Geospatial: building fast map applications

This guide is for selection first, implementation second — the same contract as
[`metaGuide.md`](metaGuide.md), narrowed to one domain.

**What this library is for here, and what it is not.** It does not build
geospatial features. maplibre-gl-js renders, turf.js analyses, deck.gl draws,
supercluster clusters, flatbush indexes, and none of that is being reimplemented
here. What this library provides is the layer _around_ those: moving coordinate
data without a JSON round-trip, deciding when to push an update, expiring a record
that stopped reporting, and knowing whether a frame budget was met.

The test every recommendation below had to pass: _does this help someone build a
performant app around maplibre / turf / deck.gl, by filling a gap those libraries
leave, without reimplementing anything they own?_ The decision record, including
everything that failed the test and why, is
[ADR 0015](../adr/0015-geospatial-scope.md).

---

## The 60-second diagnostic

1. **Where is the pressure?** Inbound message rate, source-update cost, the
   simulation step, or the frame budget?
2. **What must be bounded?** In-flight requests, queued mutations, entities in
   memory, or work per frame?
3. **Where is the boundary?** Main thread to worker, worker to renderer, or
   server to client?
4. **What may be lost?** Nothing, the newest position, the oldest position, or a
   stale entity?
5. **What measurement will prove the choice worked?** Bytes on the wire, updates
   per second, mutations dropped, or frame-time attainment?

---

## Quick chooser

| If your problem is...                                                   | Start here                                | Add these when needed                                     | Do not start with                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| A high-frequency stream of position reports is blocking the main thread | `PowerBatch` + a `Map`                    | `PowerRealtimeHub`, `PowerTTLMap`, `PowerDeduplication`   | a custom coalescer — measured, and it loses (see below)            |
| Entities stop reporting and must disappear from the map                 | `PowerTTLMap`                             | `PowerHeartbeat`, `PowerRealtimeHub`                      | a `setInterval` sweep that scans every entity                      |
| Moving a large coordinate array to a worker or renderer                 | `powerMessageCodec` (`CODECS.RAW`)        | `collectTransferables()`, `PowerBuffer`                   | a new binary format — FlatGeobuf, geobuf and PMTiles already exist |
| Duplicate or out-of-order position reports on a lossy link              | `PowerDeduplication`, `PowerSequencer`    | `PowerRealtimeHub`                                        | a hand-rolled seen-set with no window                              |
| Fanning a feed out to a map, a table, an alert engine and a recorder    | `PowerRealtimeHub`                        | `PowerEventBus`, `PowerQueue`                             | `for (ws of clients) ws.send(...)`                                 |
| A simulation must be reproducible run to run                            | an injected clock (`now` option)          | `PowerPool`, `PowerChunker`, `PowerObserver`              | wall-clock time anywhere in the step                               |
| The render thread is reading live simulation state                      | `PowerObserver` (snapshot)                | `powerMessageCodec` `RAW`                                 | sharing the live store across threads                              |
| A frame budget is being missed and you do not know whose fault it is    | `PowerApdex`, `PowerEventLoopMonitor`     | `PowerDeadline`, `PowerBrownout`                          | a hand-rolled FPS counter                                          |
| A tile server is being hammered                                         | `PowerThrottle` / `PowerGCRA`             | `PowerSemaphore`, `PowerBulkhead`, `PowerRetry`           | an unbounded request loop                                          |
| Building a Node-side geometry or tile pipeline                          | `PowerPool` + `PowerChunker`              | `PowerCache`, `PowerQueue`, `PowerRetry` / `PowerCircuit` | a single-threaded loop over a million features                     |
| Memory pressure is crashing a phone                                     | `PowerBrownout` + `getResourcePressure()` | `PowerObserver`                                           | loading everything and hoping                                      |

---

## The four use cases

Each of these is a composition of shipped helpers plus one or two gaps. The gaps
are named so you can see which recommendations are load-bearing and which are
optional.

### 1. Realtime geospatial dashboard (fleet, AIS, IoT, air traffic)

**The shape of the problem.** 5,000 entities at 1 Hz is 5,000 messages/second.
50,000 at 5 Hz is 250,000/second. The frame budget allows about 60 updates/second.
**The ratio is the whole problem.**

Placematic's fleet-dashboard case study puts 200 trucks at 10-second intervals at
648,000 GPS packets per day, and notes that at 1,000 trucks on 5 s it is 6.5
million — with the warning that _"GPS volume is the quiet problem. Anything
per-point multiplies by fleet size × ping rate."_ A published fleet-management
case study reports 5,000+ vehicles where _"the UI became sluggish when rendering
more than 500 vehicles simultaneously"_ with off-the-shelf tooling, solved by
_"using clustering and WebGL layers instead of DOM nodes."_

**The pipeline.**

```
WebSocket / MQTT
  → PowerWebSocketClient            reconnect, backoff, ping/pong, permessage-deflate
  → powerMessageCodec               framed decode (or JSON.parse)
  → PowerDeduplication              drop duplicate position reports inside a window
  → PowerSequencer                  reorder; missing() is the NACK payload
  → PowerRealtimeHub                fan-out, per-subscriber bounded queue + drop policy
      ├─ map consumer  → PowerTTLMap (entity store, TTL = staleness threshold)
      │                  → PowerBatch + a Map   ← the coalescer, and it is enough
      │                  → GeoJSONSource.updateData(diff)
      ├─ table consumer → same store, different projection
      ├─ alert consumer → PowerEventBus
      └─ recorder       → PowerQueue, drained to IndexedDB off the hot path
  → PowerApdex {target: 16.7} + PowerEventLoopMonitor   frame budget + host attribution
```

**The coalescer, and why there isn't one.** MapLibre #106's accepted workaround is
a hand-rolled `requestAnimationFrame` throttle with an in-memory cache of pending
changes. `bench/claims.js geocoalesce` measures whether a helper beats that, and
the answer is no:

| arm                        | work ms | updates | applied |
| -------------------------- | ------- | ------- | ------- |
| per-mutation               | 37.5    | 2000    | 1,980   |
| `PowerBatch`               | 4.9     | 60      | 1,980   |
| **`PowerBatch` + a `Map`** | **3.8** | 60      | 1,961   |
| a time-window coalescer    | 7.7     | 3       | 1,325   |

At every window swept (1/2/4/16 ms) the coalescer is at best equal to
`PowerBatch` + a `Map` on work, and it always applies fewer mutations — 1,716
against 1,961 at a 16 ms window, a 12.5% fidelity loss, because a longer window
collapses more under last-write-wins. **Fewer applied is not free: it means
staler positions on screen.**

So the recipe is:

```js
const pending = new Map();
const batch = new PowerBatch(async () => {
  const diff = { update: [...pending.values()] };
  pending.clear();
  await source.updateData(diff);
});
// on each mutation:
pending.set(id, mutation);
batch.add(id);
```

The `Map` does the keyed last-write-wins merge; `PowerBatch` does the coalescing.
That is the whole thing.

**The drop policy is a product decision, not a tuning knob.** _"Show me every
vehicle, and accept that the map is 3 seconds behind"_ and _"show me the freshest
5,000 and drop the rest"_ are different products. `PowerRealtimeHub` makes that a
declared option rather than an accident; inherit that property in whatever you
build on top.

### 2. Geospatial simulator (traffic, crowd, wildfire, UAV swarm, digital twin)

**The bottleneck is not the map.** It is the simulation step, and the hard
requirement is **determinism**.

RepliCore (_Reproducible Parallel Simulation under Asynchronous Browser
Runtimes_) addresses precisely this: _"Browser-based simulations execute over
asynchronous runtime mechanisms including event loops, rendering callbacks, and
independently scheduled Web Workers, causing simulation progression to depend on
runtime timing and callback scheduling behavior."_ Its model is logical time
`t_k = k·Δt` with state updates performed only at explicit simulation-step
boundaries, state partitioned across workers, and the reported result is that
_"all configurations produced bitwise-identical states across runs"_ under
1/2/4/8/16 workers and at 60, 30 and 10 FPS with rendering disabled.

CrowdFlow states the same discipline from the implementation side: _"60Hz
fixed-timestep physics"_, _"spatial hash grid for O(n) neighbor lookups,
zero-allocation hot loops"_, and — the line that matters most here — _"UI polls
stats at 10fps — never re-renders for simulation state."_

**The pipeline.**

```
fixed timestep loop, Δt = 1/60 (logical time t_k = k·Δt)
  → PowerPool + PowerChunker        partition entities across workers
      per worker: spatial hash / kdbush neighbor query
                  PowerDeadline     cap the step; shed if exceeded
  → columnar snapshot (Float32Array + property table) → RAW codec, zero-copy
  → PowerObserver                   render reads a snapshot, never live state
  → render at 60 Hz with interpolation alpha = accumulator / Δt
  → PowerApdex {target: 16.7} + PowerEventLoopMonitor
  → PowerBrownout                   degrade: fewer agents, coarser LOD, drop labels
```

**Three rules, and the first one is the reason GEO-039 exists.**

1. **The clock must be injectable.** A simulator that cannot control its clock
   cannot be deterministic. `PowerDeadline`, `PowerCircuit`, `PowerCron` and
   `PowerEventLoopMonitor` all take a `now` option for exactly this; before
   GEO-039 they did not, and `PowerCircuit` had no injection point at all. Pass
   `now: () => simTime` and the whole step becomes reproducible.
2. **The render must never read live state.** `PowerObserver` with a snapshot is
   the right shape; CrowdFlow's _"never re-renders for simulation state"_ is the
   same lesson stated as a rule.
3. **Interpolation is the app's job, scheduling is yours.** Gaffer's
   fixed-timestep pattern is accumulator + while-loop + `alpha = accumulator /
step` + a clamp to prevent the _"spiral of death"_. The accumulator, the
   catch-up cap and the clamp are scheduling; `alpha` and the lerp are yours.

### 3. Map-based videogame

**The bottleneck is the frame budget, and the enemy is allocation.** The W3C Frame
Timing spec states the constraint: _"If all of the work within each execution of
the event loop (i.e. within a 'frame') is completed in allotted time budget (e.g.
16.6ms for 60Hz refresh rate), the browser can guarantee a smooth and responsive
experience. However, if the work within the frame exceeds this time budget … then
one or more frames is skipped."_

Entity counts are small — tens to a thousand — so a columnar carrier is noise
here. What matters is that every per-frame allocation is a potential GC pause.

**The pipeline.**

```
requestAnimationFrame
  → PowerBatch (frame clock)        coalesce pointermove/wheel into one logical input
  → fixed timestep update           accumulator, Δt, maxUpdates catch-up cap
  → kdbush spatial query            what is near the player
  → render                          MapLibre custom layer / MapLibreOverlay
  → PowerApdex {target: 16.7}       frame budget attainment
  → PowerEventLoopMonitor           is a long frame ours or the host's?
  → PowerBrownout                   shed: particles → labels → picking → geometry
  → PowerGCRA / PowerThrottle       rate-limit outbound calls (leaderboard, telemetry)
```

**The library is least needed here and most likely to be misused.** The
zero-allocation primitives — `PowerQueue`, `PowerPriorityQueue`, `PowerBuffer` —
are exactly right and already shipped. What is missing is the frame-budget
composition, which is a recipe, not a helper.

### 4. Camera-movement prefetch over a slow network

**The workload.** `flyTo`, `easeTo`, `panTo` and `zoomTo` request their tiles _as
the camera reaches them_, so a movement over a slow network spends much of its
flight at reduced detail or blank. This is the use case behind MapLibre PR #8670,
which adds a `preload` option to core.

**Why this use case is in the guide even though we build nothing for it.** The
plugin that solved it from outside (`maplibre-preload`) had to monkey-patch
`panTo` / `zoomTo` / `easeTo` / `flyTo`, hijack the `Tile` class — described by
its own author as _"a community hack"_ — fall back to `fetch` for custom
protocols, and reconstruct the flight path itself, _"a second implementation to
keep in step with the first"_, which is why `zoomTo` needed a bug fix of its own.
A working, used, published solution, and it still cost all of that, because the
composition was not visible from outside.

**The measured results** (real Chrome, local tile server with a per-tile delay,
cold origin, two sources; the measure is the share of the **frame drawn** at
arrival, not the share of tiles, _"because a missing tile at the horizon occupies
almost no pixels and the two are not the same thing"_):

| flight             | per-tile delay | % viewport drawn        | tiles arrived  | requests |
| ------------------ | -------------- | ----------------------- | -------------- | -------- |
| 3 s, NYC→Tokyo z11 | 400 ms         | not measured → **100%** | 37% → **100%** | 112 → 48 |
| 3 s, NYC→Tokyo z11 | 600 ms         | 13% → **70%**           | 33% → **100%** | 97 → 36  |
| 3 s, NYC→Tokyo z11 | 800 ms         | **0%** → 67%            | 0% → 67%       | 100 → 26 |
| 3 s, pitch 55      | 600 ms         | 16% → **92%**           | 14% → 57%      | 96 → 30  |

And the number that reframes the problem: _"A moving camera's network cost is
dominated by requests it abandons. Over that flight the render loop started about
100 tile requests and **abandoned 82 of them** … With `preload` that drops to
**zero**, and total requests fall by two to four times."_

**What we build: nothing. What we document: the recipe for where core prefetch
does not reach.** Core `preload` goes through the ordinary source path, so it
covers built-in sources. It does not cover custom sources registered through
`addSourceType`, and it does not cover deck.gl layers at all.

```
sample the movement's path (destination first — camera order brings *not one*
destination tile in before arrival, and lands the destination 20–770ms LATER
than no preload at all)
  → PowerPriorityQueue            the cursor, destination-first
  → PowerBulkhead                 the in-flight window, shared equally between sources
  → PowerSemaphore                a hard bound if you want one below the bulkhead
  → PowerThrottle / PowerGCRA     pace outbound requests to the tile server
```

**The window is host-dependent and must be measured, not copied.** PR #8670
measures 12 as optimal against Chromium's ~6 connections per origin, and states
the ratio explicitly. The sweep: window 6 → 53 requests / 23 abandoned / 6
outstanding at arrival; **12 → 36 / 0 / 6**; 24 → 46 / 5 / 18.

`bench/claims.js geoprefetch` sweeps the same trade-off, and its finding is that
**the determinant is lead vs latency, not the window**. With a 1002 ms read-ahead
against 600 ms tiles, no tile can land late and none can be abandoned at _any_
window — the window then controls only how far ahead you read and how much is
still in flight when the camera lands. So tune the lead first: a window cannot fix
a lead that is too short. The mode is a simulation and says so — it cannot
discover your host's connection limit the way a browser harness can, and it cannot
reproduce PR #8670's abandonment term, because a real camera's sampled path and
actual path diverge and the model uses one path for both.

**The arrival/interruption split is a declared policy, not a detail.** Keeping
in-flight requests when a movement is interrupted costs 14.7% of viewport recovery
(4533 ms against a 3951 ms baseline). _"A blank viewport the user is looking at is
far more visible than a dozen tiles they will probably never request again, so the
asymmetry is worth having."_ That is `PowerBrownout`'s declared-policy pattern and
`PowerRealtimeHub`'s drop policy, in a different costume.

---

## Recipes

### Moving a large coordinate array to a worker

**Flatten first. Transfer second.** `bench/claims.js geoencode` measures four arms
on the MapLibre #106 payload shape (200 LineStrings × 4,500 coordinates):

| arm                                                        | ms                      |
| ---------------------------------------------------------- | ----------------------- |
| `JSON.stringify` → post string → `JSON.parse`              | 296.91                  |
| `postMessage(featureCollection)` — structured clone        | 393.75                  |
| `postMessage(float64)` — structured clone of a flat buffer | 1.66                    |
| `postMessage(float64, [buffer])` — zero-copy transfer      | ~1.3 (8.35 incl. build) |

Three things fall out of that table:

1. **Structured clone of the object graph is _slower_ than JSON.** So the obvious
   "just `postMessage` the object" answer is worse than what MapLibre already
   does.
2. **A flat buffer is 47x faster than the object graph.** The object-graph penalty
   dominates by two orders of magnitude.
3. **The win is flattening, not transferring.** Cloning a _flat_ buffer is already
   cheap; Chrome's ~46x transfer figure does not reproduce at this size.

And the stringify measurement — **196.69 ms** — independently confirms MapLibre
#106's reported _"about 200ms"_ on the same payload shape, on a different machine
and V8. That the harness reproduces someone else's number is the strongest
evidence it models the real path.

```js
import { encodeMessage, collectTransferables } from 'performance-helpers/powerMessageCodec';

// One interleaved lon/lat Float64Array. The application owns the layout.
const positions = new Float64Array(count * 2);
// ... fill it ...

// RAW stores the buffer verbatim, with no serialization at all.
const frame = encodeMessage({ __geo: 'flat', positions });
const transfer = collectTransferables({ positions });
worker.postMessage(frame, transfer);
```

`CODECS.RAW` and `collectTransferables()` already ship, and both have been
hardened against the cross-realm defect class twice (WRK-006, AUD-011). There is
no new codec to adopt.

**Bytes on the wire:** lines 34.4M json vs 13.7M flat (2.50x); points 7.2M vs 0.8M
(9.38x).

### Reducing payload size

`bench/claims.js geoprecision` measures what rounding actually saves:

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

So MapLibre's "reduce coordinate precision" advice is worth 40% on a line-heavy
dataset and 11% on a point-heavy one, and nothing at all once you have flattened.
**The win is representation choice, not a rounding pass.**

For the object-shaped case, use `turf.truncate` — it is what everyone uses and
what every tutorial shows. For a caller who already holds coordinates in a typed
array, the pass is eight lines:

```js
const round = (a, decimals) => {
  const f = 10 ** decimals;
  for (let i = 0; i < a.length; i += 1) a[i] = Math.round(a[i] * f) / f;
  return a;
};
```

A `Float32Array` column would be 4 bytes per coordinate regardless of precision,
and loses precision beyond ~6 decimals — exactly the RFC 7946 recommendation, so
the loss is acceptable but must be stated rather than discovered.

### Expiring entities that stopped reporting

`PowerTTLMap` is the primitive, and it already takes an injected clock:

```js
const vessels = new PowerTTLMap({
  defaultTTL: 30_000, // a vessel silent for 30s is gone
  onExpire: (id) => hub.publish('map', { remove: [id] }),
  now: () => simTime, // GEO-039: drive it from your own clock
});
```

The AWS sample fleet tracker shows exactly this UI — _"time since last update"_
per vehicle. `PowerHeartbeat` covers a dead peer; `PowerDeduplication` covers
duplicate position reports inside a window; `PowerSequencer` covers out-of-order
datagrams and its `missing()` is already a NACK payload.

### Bounding tile requests

MapLibre's `setMaxParallelImageRequests` (default 16) covers **images only** —
raster tiles, sprites, icons. There is no exposed bound on vector-tile requests or
GeoJSON worker messages. An application that wants one has to do it inside its own
`addProtocol` handler:

```js
import { addProtocol } from 'maplibre-gl';
import { PowerSemaphore } from 'performance-helpers/powerSemaphore';

const inflight = new PowerSemaphore(12); // ~2x Chromium's ~6 per origin

addProtocol('my-tiles', async (params, abortController) => {
  const release = await inflight.acquire({ signal: abortController.signal });
  try {
    const res = await fetch(params.url, { signal: abortController.signal });
    return { data: await res.arrayBuffer() };
  } finally {
    release();
  }
});
```

`PowerBulkhead` is the right choice when you want per-source partitions with an
equal share of the window, which is what the prefetch recipe needs.

### The frame-budget stack

Nothing in this library composes these four, and the composition is the
deliverable:

| Helper                        | Role                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PowerApdex { target: 16.7 }` | frame-budget **attainment** — the sound instrument, because `PowerHistogram.countAtOrBelow()` is unsound at the threshold (ADR 0014) |
| `PowerEventLoopMonitor`       | **attribution** — is a long frame yours or the host's?                                                                               |
| `PowerDeadline`               | a hard per-frame cap                                                                                                                 |
| `PowerBrownout`               | shedding, in a declared order                                                                                                        |

The shedding order is the product decision: particles → labels → picking →
geometry. deck.gl's own guidance is that phones are _"considerably more sensitive
to memory pressure than laptops, resulting in browser restarts or page reloads"_
— drop the label layer before the data layer, and picking before geometry.

### A Node-side geometry or tile pipeline

`PowerPool` + `PowerChunker` + `PowerCache` + `PowerQueue` compose this with no
new code. The JS-side tiling options are geojson-vt (works in Node) and vt-pbf;
the fast servers are Rust/Go (martin, tileserver-rs, go-pmtiles), and
tileserver-rs publishes 1,355 req/s on PMTiles against 759 on MBTiles, with z14
diverging sharply (1,496 vs 239).

**One trap worth knowing:** `setWorkerCount` must be called **before** any map is
created, and `prewarm()` must come **after** `setWorkerUrl` / `setWorkerCount`.
Get the order wrong and the map silently runs on one worker.

### The `updateData` vs `setData` decision rule

`GeoJSONVTOptions.updateable` carries a documented caveat — _"with caveat of a
stored simplified copy"_ — and MapLibre #7336 measures the incremental index
update at ~7.5× _slower_ than a full rebuild when all features are touched.

**Rule of thumb:** `updateData` when the diff touches a small fraction of
features, `setData` otherwise. The crossover is worth measuring on your own data
before you commit to either.

---

## When this library is the wrong half

- **You want a spatial algorithm.** turf.js owns distance, area, buffer and
  intersection. `buffer` delegates to JSTS, which cannot be vendored under this
  library's zero-dependency rule.
- **You want a spatial index.** flatbush indexes 1M rectangles in 109 ms and
  kdbush is 5–8x faster than rbush at indexing. Both expose `index.data` as a
  transferable `ArrayBuffer` by design.
- **You want clustering.** supercluster is the reference, is embedded in
  MapLibre, and clusters 6M points in a browser.
- **You want a binary geo format.** FlatGeobuf, geobuf and PMTiles exist, and
  FlatGeobuf reads 15× faster than GeoJSON on a full dataset and 705× faster with
  a spatial filter.
- **You want MVT encoding.** vt-pbf and @maplibre/vt-pbf exist. Protobuf
  wire-format compliance is a correctness exercise, not a performance one.
- **You want projection or reprojection math.** math.gl, proj4 and MapLibre's
  internals own it, and it is a subtle correctness surface with no measured
  performance premise.
- **You want a faster GeoJSON parser.** `JSON.parse` is native. The win is in
  _not parsing_.
- **You want a map engine.** That is a rendering engine, and building one would
  make this package a competitor to MapLibre rather than a complement.
- **You want camera-movement prefetch for built-in sources.** MapLibre PR #8670
  adds `preload: true` to core. Use it. This library's recipe is for custom
  sources and deck.gl layers, which core prefetch does not reach.
- **A performance claim has not been measured on the real call path.** Every
  number in this guide came from `bench/claims.js`; the ones that came from
  somewhere else are attributed.

---

## Related

- [`metaGuide.md`](metaGuide.md) — the router this guide hangs from
- [ADR 0015](../adr/0015-geospatial-scope.md) — the decision record, including
  every rejection and its reason
- [`powerMessageCodec`](powerMessageCodec.md) — `CODECS.RAW` and
  `collectTransferables()`, the transport the recipes above are built on
- [`powerRealtimeHub`](powerRealtimeHub.md) — bounded fan-out with a declared drop
  policy
- [`powerTTLMap`](powerTTLMap.md) — expiring keys, with an injected clock
- [`powerApdex`](powerApdex.md) and
  [`powerEventLoopMonitor`](powerEventLoopMonitor.md) — the frame-budget stack
- [`powerBrownout`](powerBrownout.md) — shedding optional work under pressure
