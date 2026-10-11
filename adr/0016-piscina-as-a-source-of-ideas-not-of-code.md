# 0016. Piscina as a source of ideas, not of code

**Status:** Accepted
**Affects:** no shipped code. One new guide section is not required; the open work is
tracked as `PISC-*` rows in the review table, and the rejected patterns are recorded here
so they are not re-litigated.
**Evidence:** reading Piscina (`current` branch) against this repository's own
cross-realm constraint set. The one finding that produced shipped code — F-14, the
fifteen `instanceof ArrayBuffer` sites in `powerPool.js` — was fixed in `440c625` and is
pinned by 27 tests in `test/powerPool.prepareBuffers.test.js`.

## Context

Piscina is a mature Node worker pool. This repository ships `PowerPool`, which does the
same job across six realms rather than one. The question was whether Piscina's design
should be ported, and if not, what should be taken from it.

The answer is that the two libraries have different threat models, and a technique that is
merely an optimisation in one is a correctness requirement in the other. Piscina is
Node-only and single-realm by construction: every value it handles was created in the same
realm as the code testing it, so `instanceof` is always correct there and the question
never arises. Reading Piscina therefore **cannot** surface this class of defect. The
cross-realm lens has to be applied on top of the Piscina reading, not derived from it.

That is why the honest framing is "inspired by" rather than "port from", and it is why the
highest-severity finding in the whole comparison was invisible to the comparison itself.

## Decision

Take Piscina's _questions_, not its answers. Every candidate was tested against one
question: _does this survive all six realms, and does it earn its complexity here?_

Eight patterns were examined and rejected. They are recorded with their reasons, because
the reason is the part a future reader cannot reconstruct from the code.

| Pattern                                                          | Why not                                                                                          | Cross-realm note                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `niceIncrement`                                                  | Requires the optional native `@napi-rs/nice` addon. `REJ-008` forbids runtime dependencies.      | Also Node-only by construction.                                                                                                                                             |
| `resourceLimits`, `env`, `argv`, `execArgv`, `trackUnmanagedFds` | All already pass through `workerOptions` to the `Worker` constructor. Non-actionable as code.    | Documentation-only, and the documentation must say these are Node-shaped and ignored by a browser worker.                                                                   |
| `withNullPrototype` option merging                               | `assertKnownOptions` is stricter — it rejects unknown keys rather than silently ignoring them.   | No cross-realm dimension.                                                                                                                                                   |
| `EventEmitterAsyncResource` / `TaskInfo extends AsyncResource`   | async-hooks integration so diagnostics span the post→response boundary.                          | `node:async_hooks` does not exist in a browser, so any adoption is a capability-gated split — the thing this library avoids. PowerPool has its own context story instead.   |
| stdout/stderr drain before task completion                       | Piscina waits for `writableLength === 0` so worker logs are not lost.                            | `process.stdout` is Node-only, and the technique is tied to the rejected Atomics path.                                                                                      |
| Replacing Welford with an HDR histogram outright                 | Welford's O(1) memory is a real property.                                                        | `node:perf_hooks` histograms are Node-only. Percentiles are added _alongside_ via the local `PowerHistogram` (PISC-002), not by swapping.                                   |
| `FixedQueue` as a drop-in for `PowerQueue`                       | A candidate, not a drop-in. Priority, weight, `shrink()` and `dispose()` would all need porting. | No cross-realm dimension; ADR 0002 already rejected a pure linked list.                                                                                                     |
| Piscina's `Atomics` wakeup as the default worker protocol        | Four independent blockers.                                                                       | `receiveMessageOnPort` is Node-only; `Atomics.wait` is blocked on the browser main thread; `SharedArrayBuffer` needs COOP/COEP headers; and the premise is unmeasured here. |

Two candidates survived the lens unchanged, because they are web standards and therefore
realm-safe by construction: per-task `AbortSignal` (PISC-003) and a dedicated
`MessageChannel` per worker (PISC-010).

## The finding the lens produced

F-14 is the reason this ADR exists, and it was not in the Piscina comparison at all.

`src/helpers/powerPool.js` carried **fifteen** `instanceof ArrayBuffer` sites. The codec
layer immediately beneath it was already fixed for this exact defect class —
`powerMessageCodec.js` uses `isArrayBuffer()` at eight sites with comments naming the
defect — and `powerPool.js` already imported from `powerBuffer.js`, just not that symbol.

The concrete failure: a cross-realm `ArrayBuffer` fails `instanceof ArrayBuffer`. At the
`isTransferable` gate, a cross-realm `Uint8Array` accidentally survives via the
`ArrayBuffer.isView` fallback, but a cross-realm **`ArrayBuffer`** survives none of the
three checks — so it is routed down the encode path instead of the zero-copy path.

**This is the exact failure `AGENTS.md` predicts**, and the prediction is worth quoting
because it named the mechanism in advance:

> Two of the three defects above were in code that had _already_ been fixed for this class,
> because `isView` covered views and the author read that as covering the file. **When you
> fix one site of a defect class, grep for the class and not for the site.**

The codec file was fixed. The pool file was not. The class was never grepped.

The severity turned out to be a lost zero-copy optimisation rather than corruption — the
data survived, because `_encodeForTransfer` reads the bytes correctly for a foreign buffer
— but that was measured, not assumed, and the `awaitResponse` site on the same path _was_
data loss: it augments the message with a `correlationId` via `Object.assign`, which is
only safe for a plain object.

## Consequences

- **The sweep is complete and it found more than the comparison did.** Grepping the class
  rather than the site produced four defects across four files: `utils/transferable.js`,
  `cache/core.js` (a `Set` comparing a colliding pair twice, reachable with **no**
  cross-realm fixture at all), `cache/memoizer.js` (`simpleArgsKey` encoding every
  cross-realm `Date`, `RegExp`, `Map` and `Set` as an empty object), and `powerPool.js`.
  Three of the four were in files already fixed for the class.
- **The recurring shape is a neighbouring correct check.** In every case a _correct_
  realm-independent test sat beside the broken one — `isError` in `memoizer.js`,
  `ArrayBuffer.isView` in `powerPool.js`, the `isArrayBuffer` call in the same expression
  in `core.js` — and that is what made the file read as covered. A future audit should
  treat "this file already uses the realm-independent helper" as a prompt to grep, not as
  evidence of safety.
- **The open work is tracked, not lost.** `PISC-001` to `PISC-012` are rows in the review
  table with priorities, ROI, risk and effort. `PISC-013` to `PISC-019` are the rejected
  patterns above. `PISC-020` and `PISC-021` — the fifteen sites and the pool-level
  cross-realm tests — are done in `440c625`.
- **A cross-realm test needs a real second realm.** `node:vm`, not a hand-rolled
  `{ byteLength: n }` stand-in: `new Uint8Array()` _accepts_ such a stand-in, so the wrong
  fixture passes for the wrong reason. Every test added for this class uses `node:vm`.
