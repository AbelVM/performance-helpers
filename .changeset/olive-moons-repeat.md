---
'performance-helpers': minor
---

Runs the W-TinyLFU admission-window experiment, and closes it on a measured
**no**.

`design/0001-tinylfu-admission-window.md` ended on one question — _raise the
window floor and see whether retention follows_ — after two implementation
attempts were reverted. It has now been asked.

The window is implemented in `PowerCache` behind an opt-in `windowSize` option
(default `0`, so nothing shipped changes), and the sweep runs inside
`bench/claims.js zipf` rather than in a private script. A standalone harness
written first produced numbers that disagreed with the benchmark — 58 % against
its 75 % — and was discarded: the moment the workload stops being the
benchmark's own, the measurement stops meaning anything.

**The first sweep read negative, and it was an artifact.** All seven window
sizes (1–32) landed within a point of the shipped no-window behaviour, which
reads as "a frequency filter earns nothing here". It was not that. Two boundary
bugs were producing the result, both found by the tests the experiment required,
and neither raised an error:

- Arbitration judged the entry count **after** the insert, so the last key of
  every fill contended with a main-space victim it should have been promoted
  past, and a 40-key warm ended at **39** entries.
- `_windowOldest()` walked a fixed number of steps, which is correct only while
  the window is full. A challenger that loses arbitration is dropped and the
  window is briefly one short, at which point the walk crossed into main space
  and a recency bump landed _behind_ a key inserted fifty sets later, silently
  destroying main space's recency order.

Fixing the first moved `windowSize: 1` from 70.9 % to **76.5 %** — from below
plain LRU to above it. **A negative sweep result deserves a second look before it
is believed.** This one looked like a finding about the mechanism and was a
finding about a boundary.

Corrected, retention follows the floor and then runs away from it:

| variant                | ws hit rate | survivors |
| ---------------------- | ----------: | --------: |
| `lru`                  |      75.0 % | 17.2 / 40 |
| `admission: 'tinylfu'` |      70.8 % | 15.2 / 40 |
| `+ windowSize: 1`      |  **76.5 %** | 15.4 / 40 |
| `+ windowSize: 16`     |      70.3 % | 18.8 / 40 |
| `policy: 'slru'`       |  **89.4 %** | 33.0 / 40 |

Small windows maximise the hit rate; large windows maximise the survivor count
and lose it, because a bigger window admits more scan keys into main space and
more working-set keys survive the run having been displaced and re-admitted
during it.

**The cold-start case is not met at any window size**, and it is the case the
window was built for. `node bench/claims.js coldstart` — a cold 40-entry cache
flooded with 460 one-shot keys, then the working set worked five times:

| variant                |   hit rate |
| ---------------------- | ---------: |
| `lru`                  | **80.0 %** |
| `admission: 'tinylfu'` |      0.0 % |
| best window size       |      2.0 % |

A working-set key arriving into a cold sketch ties with the scan keys already
resident, and a tie is not a win — so the filter refuses exactly the traffic it
should admit, indefinitely, because a key that is never admitted never
accumulates the frequency that would let it win. TinyLFU needs history, and a
cold cache flooded by a one-shot scan is the workload built specifically to deny
it.

The design note's gate was four criteria, all or nothing. **Two of four are
met**, so the window does not ship as a recommended option: `windowSize` stays
`0` by default and is documented as not recommended, and `policy: 'slru'`
remains the measured answer to scan resistance at 89.4 %.

Also in this release:

- `node bench/claims.js coldstart` is a new workload measuring cold start
  separately from the sustained mix, because the two answer differently and
  reporting only the second is what made the sustained result look like a win.
- `node bench/claims.js zipf` now includes the window-floor sweep by default.
  `CLAIM_WINDOW_SWEEP=0` turns it off.
- Twelve tests in `test/powerCache.window.test.js` pin the invariants the
  mechanism rests on: a 40-key warm reaches 40, the window and the counter
  always describe the same set of nodes, `size` never exceeds `maxEntries`, and
  `onEvict` fires on window evictions.
