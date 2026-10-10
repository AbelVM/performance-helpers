---
'performance-helpers': patch
---

### Fixed

Three guides documented methods that do not exist, each inside a **runnable code
example** — the one place no check in this repository could see:

- `guides/powerServo.md` and `guides/powerFlowControl.md` told the reader to call
  `pool.setConcurrency(n)`. `PowerPool` has `resize(n)` ("Resize the pool's
  maximum size at runtime"); nothing named `setConcurrency` exists anywhere under
  `src/`. A reader following either example got a `TypeError`.
- `guides/powerEventLoopMonitor.md` called `metrics.gauge(...)` in three places
  and `metrics.increment(...)` in a fourth. `MetricsCollector` declares
  `register`, `unregister`, `snapshot` and `names`, and nothing else. All four
  are now the real `metrics.register(name, read)` pull form, matching
  `guides/metrics.md`.

  The same examples were also missing the binding for `metrics` itself — it is
  not a package export, only a local `const` in `guides/metrics.md` — so a reader
  hit a `ReferenceError` before reaching the `TypeError`. Both blocks now carry
  the `import { MetricsCollector }` and the `const metrics = new MetricsCollector()`
  they were missing.

### Added

`test/docsCodeAgreement.test.js` gains **GATE-010**, which scans fenced code
blocks for `recv.method(` calls. GATE-002 and GATE-005 both scan _inline_
backticked calls and neither can see a code block, because a block holds raw
`obj.method(` rather than a backticked name. That is exactly the shape of the bug
GATE-002 was written for: `guides/powerPool.md` documented `prepareBuffer` in its
API list **and called it in a runnable example**, and only the API list was ever
checked.

Two layers, both measured before being written:

- **Precise** — resolves a receiver to a class constructed in the same block
  (`const pool = new PowerPool(`) or to a library singleton
  (`defaultMetrics` → `MetricsCollector`), and requires the method to be a member
  of that class. 274 call sites, 0 mismatches.
- **Union** — for unresolved receivers, requires the method to exist somewhere
  under `src/` or in a stop-list, skipping platform-global receivers
  (`Promise.all(`, `JSON.stringify(`, `Math.ceil(`). 409 call sites, 0 mismatches.

Mutation-checked with three planted faults, all caught: a bogus method on a
resolved receiver, a bogus method on an unresolved receiver, and a bogus method
in `metaGuide.md` — the highest-traffic guide in the repository, and one that
only this gate can reach.

### What this gate cannot see

The union layer accepts a name that exists _anywhere_ under `src/`, so a wrong
method on a library object passes if an unrelated class happens to declare it.
`metrics.increment(` was exactly that: `src/utils/smallLfu.js` declares an
`increment`, so the union layer would have accepted a call `MetricsCollector`
does not have. It was found by reading the guide, not by the gate. The precise
layer closes that hole for every receiver it can resolve; for the rest a reader
is still the backstop, and the limitation is recorded in a comment at the check
rather than left for the next person to assume otherwise.
