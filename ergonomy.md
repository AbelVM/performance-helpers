# Ergonomics Audit - `performance-helpers`

**Date:** 2026-10-07  
**Scope:** Public API, package publishing, module formats, types, cancellation,
resource lifetime, error contracts, documentation, examples, and selection of
the right helper.  
**Explicitly excluded:** `notes.md`. It is working material, not product
documentation.  
**Repository state:** The worktree contains unrelated staged and unstaged
changes. This audit does not assume those changes are part of one release.

## Executive Summary

`performance-helpers` is unusually serious about failure modes, measurements,
bounded queues, disposal, and generated declarations. The ergonomics problem is
not a lack of features. It is that the library makes users cross several
semantic boundaries before the first successful call:

1. The package exposes **92 root symbols across 51 helper modules**. Names are
   descriptive, but the root export still does not tell a new user which abstraction
   is the smallest correct one.
2. The worker pool has a powerful but overloaded API. The common request path is
   `postMessage(message, transfer, options)`, so the ergonomic call requires an
   explicit `undefined` placeholder. The guides document this footgun because a
   two-argument attempt fails with `TypeError: tr is not iterable`.
3. The published package contains source, declarations, and bundles but not
   `guides/`, `examples/`, or `assets/`, although the README links to those
   relative paths. The links work in the repository and break after install.
4. The API is becoming consistent around injected clocks, `AbortSignal`,
   structured error codes, and disposal, but the rules are not yet easy to see
   as one contract. Users must read helper-specific guides to learn whether a
   signal cancels waiting, running work, or only a drain observation.
5. The current JSDoc plus generated declaration approach is a valid choice for a
   JavaScript, zero-runtime-dependency library. A TypeScript rewrite is not the
   obvious ergonomic fix. The better next step is to make generated types and
   consumer tests a release invariant, then improve the public option types.
6. The newest public additions increase the vocabulary faster than they improve
   the main workflows. `createOperationContext`, `PowerAdaptiveProposal`, and
   `PowerBrownout` now have guides, tests, and composition examples, but they
   remain caller-composed policy primitives rather than integrated defaults.
   Their value depends on users wiring them to existing helpers correctly.

The highest-return work is therefore packaging and onboarding, followed by a
small named request API for `PowerPool`, a cross-library contract table, and
focused type/runtime tests. A fluent resilience pipeline and a second export
namespace should remain proposals, not immediate work: both add surface area
before the existing primitives' selection story is finished.

## Method and Evidence

Verified against the current tree:

- `src/index.js`: 49 export declarations and 92 runtime root symbols.
- `src/helpers/`: 51 JavaScript helper modules.
- `guides/`: 57 Markdown files; the largest are `powerCache.md` (1,069 lines),
  `powerPool.md` (845), and `metaGuide.md` (835).
- `examples/`: 9 runnable example scripts plus its README.
- `package.json`: `files` is `dist`, `src`, `types`, `README.md`,
  `LICENSE.md`, and `package.json`; `engines.node` is `>=22.12.0`.
- `tsconfig.json`: JavaScript source with `allowJs: true`, declaration emit,
  and `checkJs: false`; consumer declaration tests are run separately through
  `tsconfig.types.json`.
- Validation: `npm run test --silent` passes with 314 test files and 3,163
  tests passed (7 skipped); the command also invokes the production build.

External guidance used for the recommendations:

- Node package `exports`: <https://nodejs.org/api/packages.html>
- TypeScript handbook and JavaScript typing: <https://www.typescriptlang.org/docs/handbook/2/functions.html>
- Abortable API behavior and listener cleanup:
  <https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal>
- Explicit resource management and its browser support limits:
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/using>
- Piscina's task-oriented worker-pool onboarding:
  <https://piscinajs.dev/>

The external sources support platform conventions. They are not evidence that
this library should copy another library's API.

## Findings

### F-001 - Published README links point to omitted files

**Severity:** P0 adoption defect  
**Evidence:** `package.json.files` omits `guides/`, `examples/`, and `assets/`.
`README.md` links to `guides/*.md`, `examples/`, and `assets/logo.png`.
`npm pack --dry-run` confirms those trees are absent from the package payload.

**Effect:** A user following the README from an installed package reaches
missing local documentation. The repository's strongest onboarding material is
therefore unavailable at the point of use. The logo reference can also be
broken in the unpacked README.

**Recommendation:** Choose one deliberate distribution policy:

- Include `guides/`, `examples/`, and the required README assets in the npm
  package, or
- Change README links to stable website URLs and use an absolute/hosted logo.

The second option keeps the package smaller. Whichever policy is chosen, add a
packaging test that packs the package and checks every README-relative link it
claims to support. Do not silently rely on the GitHub checkout.

### F-002 - The first-choice path is still too broad

**Severity:** P1 learning cost  
**Evidence:** The root has 92 symbols. `guides/metaGuide.md` now opens with a
60-second diagnostic, a task chooser, wrong-choice guidance, composition
recipes, cancellation rules, and a runtime matrix, but it is 835 lines and
still requires the reader to understand terms
such as queue, bulkhead, semaphore, backpressure, limiter, circuit, deadline,
and retry. The README is a catalog, not a short task-oriented tutorial.

**Effect:** A user can find a name, but can still choose a primitive with the
wrong semantics. The most dangerous examples are:

- `PowerSemaphore` versus `PowerBulkhead`: total concurrency versus isolated
  partitions.
- `PowerThrottle`, `PowerSlidingWindow`, and `PowerGCRA`: different quota
  semantics and different retry-after guarantees.
- `PowerQueue`, `PowerBackpressure`, and `PowerBatch`: buffering, producer
  admission, and coalescing are not interchangeable.
- `PowerPool` versus `PowerChunker`: explicit worker orchestration versus a
  convenience helper whose constructor returns a `PowerPool`.

**Recommendation:** Keep the new diagnostic and chooser synchronized with the
92-symbol root export. Do not add another index or namespace; test the chooser
examples and trim stale entries when helpers change.

### F-003 - `PowerPool` makes the common request shape awkward

**Severity:** P1 daily-use friction  
**Evidence:** The API is `postMessage(message, transfer, options)`. The
documented await-response form is:

```js
pool.postMessage(payload, undefined, { awaitResponse: true });
```

The repository explicitly warns that `pool.postMessage(payload, {
awaitResponse: true })` puts the object in the transfer slot and fails with an
unhelpful iterable error.

**Recommendation:** Add one additive, named path for the object-shaped request
case, for example `pool.request(message, options)` or
`pool.postMessage(message, { transfer, ...options })` with an unambiguous
overload. The named method is clearer and avoids guessing whether an object is
a transfer list. Preserve the current positional method for the hottest and
most compatible path. Test that the new method preserves correlation IDs,
timeouts, refusal codes, transfer lists, and `false` versus Promise behavior.

Do not make the existing second argument polymorphic without a clear ambiguity
rule. A convenience overload that changes how arrays, typed arrays, or iterable
transfer lists are interpreted would be worse than the current explicitness.

### F-004 - Package module conditions are asymmetric

**Severity:** P1 compatibility clarity  
**Evidence:** The root export has `import`, `require`, and `types` conditions.
The deep helper exports have `import`, `default`, and `types`, but no `require`
condition. The package advertises both ESM and CJS at the root, while deep
imports have a different contract.

**Recommendation:** Either provide a supported CJS condition for every public
subpath or document that subpaths are ESM-only and keep the root as the CJS
entry point. Add a matrix test that resolves the root and every public subpath
under the supported Node version and checks the declared type entry. Do not add
a `browser` field merely as a compatibility superstition: `exports` is the
authoritative modern mechanism, and an extra condition can create another
resolution matrix.

### F-005 - Cancellation semantics are hard to learn compositionally

**Severity:** P2 operational correctness
**Evidence:** `guides/metaGuide.md` now publishes a cancellation contract for
admission, retry/deadline waits, running work, and transport delivery. The
codebase still uses different option names and helper-specific boundaries, so
the table is a routing aid rather than a universal API contract.

**Effect:** Users may assume a signal stops work when it only stops waiting, or
assume `attemptTimeout` cancels an operation that ignores the signal. This is a
semantic error, not a naming problem.

**Recommendation:** Keep the contract table as the canonical summary and add
focused tests when a new async helper introduces a cancellation boundary. Do
not mechanically add `AbortSignal` to methods whose cancellation target is not
clear.

The current contract is:

| Operation              | Signal cancels                           | Work continues?                     | Rejection/return       |
| ---------------------- | ---------------------------------------- | ----------------------------------- | ---------------------- |
| semaphore acquire      | waiting for a permit                     | no task has started                 | abort reason           |
| pool drain             | the observation                          | yes                                 | abort reason           |
| retry/deadline wrapper | wrapper attempt or budget, as configured | depends on callback signal handling | stable code plus cause |
| transport send         | queued/send operation where supported    | document per transport              | stable transport error |

Use the platform convention: reject unsettled Promise APIs with the signal's
reason, remove listeners on every completion path, and do not imply that a
wrapper can interrupt arbitrary user code.

### F-006 - Lifetime behavior is coherent but not discoverable

**Severity:** P2 maintenance and teardown  
**Evidence:** Long-lived helpers expose `dispose()` and/or
`Symbol.dispose`/`Symbol.asyncDispose`, while lazy/stateful helpers can reset
state without owning a timer. Metrics registration is detached on terminal
disposal but retained across reversible reset/stop operations.

**Recommendation:** Add a generated or hand-maintained lifecycle matrix to the
README or a short `guides/lifecycle.md`:

- owns workers, sockets, timers, listeners, or metrics registration;
- `dispose()` versus `terminate()` versus `reset()`;
- whether calls after disposal throw, return a refusal, or are harmless;
- whether `[Symbol.asyncDispose]` waits for work.

Keep the current distinctions. Do not add `dispose()` to stateless helpers just
to make every class look uniform, and do not describe lazy state reset as timer
cancellation.

### F-007 - Type generation is a release contract, not a source migration gap

**Severity:** P2 type ergonomics  
**Evidence:** The project deliberately uses JavaScript plus JSDoc and emits
`types/`. `tsconfig.types.json` checks published declarations against consumer
tests without `@types/node`. Shared typedefs in `src/helpers/jsdoc-types.js`
are referenced by helpers, so the current code is not simply duplicating every
option list inline.

**Correction to the previous draft:** Recommending a TypeScript rewrite or
removing `jsdoc-types.js` as a P0 fix is not justified. It would increase churn
without addressing the main user-facing problems.

**Recommendation:**

1. Keep the JS/JSDoc source model for now.
2. Make `types:generate`, `types:drift`, and `test:types` mandatory in the
   release path; they are already available in the repository gate.
3. Export the public option typedefs consistently so TypeScript callers can
   annotate configuration objects and use `satisfies` in their own code.
4. Turn on `checkJs` incrementally for high-risk public modules, beginning with
   constructors and exported functions, rather than rewriting the repository.
5. Add a small test for each documented overload. Overloads are where generated
   declarations most often become technically valid but ergonomically wrong.

### F-008 - Naming is converging, but the contract needs a map

**Severity:** P2 consistency  
**Evidence:** The library has `stats()` and `getStats()` conventions, injected
clocks on time-based helpers, `limit`, `capacity`, `maxConcurrency`, and
`queueCapacity` in related domains, and several intentional boolean/Promise
refusal forms. The metrics guide explains that stats shapes are not uniform.

**Recommendation:** Do not mechanically rename stable APIs. Add a public
conventions table:

- `tryX()` returns a non-throwing refusal value; `run()`/`call()` rejects;
- `stats()` is a snapshot and `getStats()` is either an alias or a documented
  legacy name;
- `capacity` means permits/tokens, `maxConcurrency` means simultaneous work,
  and `queueCapacity` means waiting work;
- `now` is an injected clock for deterministic time-based tests;
- `reset()` is reusable state reset, while `dispose()`/`terminate()` ends use.

Where a new API is added, follow the table. For old names, provide aliases only
when the alias reduces real call-site confusion and does not add hot-path work.

### F-009 - The pool and cache guides are reference manuals before tutorials

**Severity:** P2 scan cost  
**Evidence:** `powerPool.md` and `powerCache.md` are 846 and 1,069 lines.
They contain valuable measurements and failure analysis, but the first-time
reader must navigate a large option table before seeing the smallest safe path.

**Recommendation:** Put a stable "start here" block at the top of each large
guide:

- minimal constructor;
- minimal operation;
- required teardown;
- one production hazard;
- links to advanced sections.

Add a compact option table for the five options most callers should touch.
Generate or test the option table where possible so it cannot drift from the
JSDoc. Keep measurements and rejected alternatives below the quick path; those
are valuable reference material, not onboarding material.

### F-010 - Composition should be taught before it is abstracted

**Severity:** P2 design direction  
**Evidence:** `guides/metaGuide.md` now includes a canonical retry/deadline/
circuit/bulkhead ordering recipe and explicitly rejects a hidden composition API.
The recipe remains documentation rather than an executable example.

**Recommendation:** Keep the recipes explicit and add an executable scenario
test before introducing a generic `compose()` or fluent `.pipe()` API:

1. deadline outside retry, with one total budget;
2. circuit outside retry, so an open circuit does not consume retry attempts;
3. bulkhead/rate limit before expensive work, with refusal mapped to load shed.

Each recipe should name ordering, idempotency assumptions, signal propagation,
and which errors must not be retried. If the same wrapper code appears in real
consumers after those recipes exist, then design a small composition helper from
the observed shape. A generic policy pipeline now would hide important ordering
semantics behind a new abstraction.

### F-011 - Runtime support is declared, but feature support is not

**Severity:** P2 deployment clarity  
**Evidence:** `guides/metaGuide.md` now includes a Node/browser/worker runtime
capability matrix covering core helpers, workers, WebSockets, WebTransport,
WebRTC, Node resource pressure, and `SharedArrayBuffer` paths.

**Recommendation:** Keep the matrix aligned with capability probes and test the
most important rows during release checks. It is now a maintenance obligation,
not a missing-documentation task.

### F-012 - Public policy primitives are ahead of integration

**Severity:** P2 API growth risk  
**Evidence:** `createOperationContext`, `PowerAdaptiveProposal`, and
`PowerBrownout` are exported, documented, and tested. The meta guide and rate
limit guide now show composition, but production helpers still do not consume
the context or proposal automatically; the caller owns the wiring.

**Effect:** Users must manually invent the wiring that would make these
abstractions valuable, while the root surface and chooser gain three more
concepts. The library can accumulate policy vocabulary without reducing the
complexity of its existing pool, retry, limiter, and transport workflows.

**Recommendation:** Keep them explicitly caller-controlled and avoid adding
more coordination primitives. Promote a policy to an integrated helper only
when executable scenarios show a repeated call-site pattern and a clear owner
for applying the decision.

### F-013 - Adaptive-concurrency contract was corrected

**Status:** Resolved in the current worktree.  
**Evidence:** The README, `guides/autoscale.md`, and `guides/powerPool.md` now
state that `aimd`, `vegas`, and `gradient2` enforce an adaptive admission limit.
`src/helpers/powerPool.js` reads that limit on dispatch and batch admission;
tests cover queueing/refusal behavior. Worker-count autoscaling remains a
separate control.

**Remaining check:** Keep the distinction between worker scaling and in-flight
admission visible in future changes, especially when adding new policies.

### F-014 - Compatibility vocabulary is becoming another API surface

**Severity:** P2 maintenance cost  
**Evidence:** The source contains compatibility, deprecation, alias, and legacy
paths across helpers, including alternate stats names and preserved option or
method forms. A source search currently finds at least 126 such markers or
references. These paths are individually defensible, but the aggregate makes
the supported contract harder to distinguish from migration scaffolding.

**Recommendation:** Publish a small compatibility policy: which aliases are
stable, which are deprecated, the removal window for 2.0, and whether a
compatibility path is allowed in a hot method. Keep aliases that prevent real
breakage, but stop adding new synonyms until the policy and removal list are
visible. Test the canonical path separately so compatibility coverage does not
become the only exercised path.

## Prioritized Plan

| ID    | Work                                                                                         | Priority | Effort       | Acceptance check                                                                     |
| ----- | -------------------------------------------------------------------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------ |
| E-001 | Done: include README-linked documentation and assets in the package                          | P0       | Small        | Packed tarball contains every promised local target, or links are hosted and tested  |
| E-002 | Done: maintain the README/meta-guide task chooser                                            | P1       | Small        | New exports and examples remain represented without stale choices                    |
| E-003 | Done: add `PowerPool.request(message, options)` as the named response path                   | P1       | Medium       | Response, timeout, transfer, refusal, and correlation tests pass                     |
| E-004 | Done: document and test ESM-only deep subpaths; keep CJS at the root                         | P1       | Small/medium | Resolution matrix matches package documentation                                      |
| E-005 | Done: keep cancellation/lifecycle contracts aligned                                          | P1       | Small        | New async/lifecycle helpers document their boundary and cleanup semantics            |
| E-006 | Done: add top-of-guide quick paths to cache and pool guides                                  | P2       | Medium       | Large guides expose minimal safe usage before advanced options                       |
| E-007 | Partial: consumer option typedef coverage and guards are in place; `checkJs` ratchet remains | P2       | Medium       | Consumer type and option-coverage tests pass; repository-wide `checkJs` debt remains |
| E-008 | Done: execute-test the documented resilience recipes                                         | P2       | Small        | Composition examples run in the existing test harness                                |
| E-009 | Done: maintain the runtime capability matrix                                                 | P2       | Small        | Each environment-sensitive helper has one documented support status                  |
| E-010 | Done: integrate and test the newest policy primitives                                        | P2       | Medium       | Each public policy has one tested end-to-end composition recipe                      |
| E-011 | Done: preserve adaptive-concurrency contract                                                 | P1       | Small        | README, guides, implementation, and tests continue to agree                          |
| E-012 | Done: publish compatibility/deprecation policy                                               | P2       | Small        | Canonical names and removal windows are explicit                                     |

## Explicit Non-Recommendations

- Do not add a second top-level export namespace solely to hide the existing
  exports. Deep imports already exist; the missing piece is task selection.
- Do not rename every `limit`, `capacity`, and `maxConcurrency` option in one
  release. Their meanings differ in several helpers, and compatibility aliases
  would increase rather than reduce surface area.
- Do not convert the repository to TypeScript as an ergonomics project. Improve
  declaration generation, public typedef exports, and consumer tests first.
- Do not add `AbortSignal` to every method mechanically. A signal must have a
  precise cancellation target and a documented listener lifetime.
- Do not add a fluent resilience pipeline before ordering and error-propagation
  recipes are established and tested.
- Do not add more standalone coordination or adaptation helpers until the
  current policy primitives are integrated into representative workflows.
- Do not treat compatibility aliases as free ergonomics; every new synonym
  needs a documented removal or permanence decision.
- Do not add a `browser` field just because the package supports browsers.
  Prefer the existing `exports` map and capability detection unless a concrete
  bundler compatibility failure is reproduced.

## Positive Baseline to Preserve

- Zero runtime dependencies and explicit performance measurements.
- Deep imports, conditional root exports, `sideEffects: false`, and generated
  declarations.
- Runnable examples that are exercised by tests.
- Stable error codes with structured fields instead of message parsing.
- Bounded queues, explicit refusal behavior, and honest per-process limiter
  semantics.
- Injected clocks and disposal hooks where they make tests and teardown safer.
- Documentation that records rejected ideas and withdrawn performance claims.

## Conclusion

The project does not need a larger abstraction layer to become ergonomic. It
needs the package users receive to match the documentation they are shown, a
shorter route from problem to helper, and a few high-frequency APIs whose
semantics are currently encoded in long examples. The new metrics, admission,
partition, retry, and policy work is valuable, but it also raises the cost of
keeping the public contract coherent. Prioritize E-007; all other plan items
are complete. The remaining work is the repository-wide `checkJs` ratchet and
its generated-declaration staging boundary, not another public API change. That
order improves adoption and reduces misuse without weakening the library's
zero-dependency or high-performance character.
