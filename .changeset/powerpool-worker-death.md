---
'performance-helpers': patch
---

### Fixed

**`PowerPool` now detects a worker that dies, settles it, and replaces it.**

Before this, a dead worker was simply absent, and three things followed — all
observable from outside as "the pool stopped working":

- `drain()` hung, waiting for a response that would never arrive;
- every `awaitResponse` promise timed out instead of rejecting, so a caller waited
  the full timeout — 30 s by default, forever under `awaitResponseTimeout: Infinity`
  — to learn what had already happened;
- the pool sat below `minSize` permanently, because nothing noticed the shortfall.

The pool now settles the dead worker's in-flight tasks and **rejects its pending
responses at the moment of death** rather than at a timeout, removes it, emits
`pool:worker:exit`, and refills toward `minSize`.

**The bootstrap guard is the part worth understanding.** A worker that dies having
never completed a task is a worker that failed to _load_ — a syntax error, a missing
module, bad `workerOptions`. Refilling on every such death is a respawn storm: each
replacement loads, throws, dies, and is replaced, at full CPU, forever. So **three
consecutive load-failures stop the refill** and the reason is logged rather than
retried. That bound is a judgement call borrowed in substance from Piscina's
`workerFailsDuringBootstrap`, not a measured number. A worker that had been working
and then died is a _crash_, not a load failure, and resets the bound — otherwise one
bad deploy would permanently shrink a healthy pool.

**Known limitation, recorded rather than papered over: this is Node-only.** A browser
`Worker` has no `'exit'` event, so the handler never fires there and the
`drain()`-hangs symptom persists in that runtime. There is nothing to listen for;
inventing a heartbeat to detect death would be a different feature with its own
false-positive rate.

### Changed

- `WorkerAgnostic` normalises a fourth event, `'exit'`, alongside `message`, `error`
  and `messageerror`. It is Node-only in practice — a browser `Worker` has no such
  event, so registering it there is a no-op that never fires — and it is normalised
  anyway rather than special-cased at the call site, because the alternative is every
  consumer re-deriving "does this runtime tell me when a worker dies", and the answer
  changes per runtime, which is exactly what the class exists to absorb.
- `WorkerLike`'s `postMessage` transfer parameter is now the library's own
  `TransferList` rather than a hand-written `Object | ArrayBuffer[] |
ArrayBufferView[]`, and its four handler properties are nullable. Both were
  pre-existing mismatches against `WorkerWrapper` that this change exposed; aligning
  them **removes four errors from the type ratchet** (182 → 178).

### Tests

8 tests in `test/powerPool.workerDeath.test.js`, mutation-checked 6 of 6: the
`everCompletedTask` guard, the exit wiring, the refill loop, the `_terminated` guard,
the idempotence guard, and the crash reset.

Three of those tests initially passed against the defect they were written to catch,
and the reason is worth recording. The shutdown test asserted on `workers.length`,
which is `0` either way because `shutdown()` already empties the set; the idempotence
test reached for `pool.workers[0]` a second time, which targets the _replacement_
worker the refill just created; and the crash-reset test asserted `0` on a counter
that was already `0`. Each now asserts on the quantity that actually moves — workers
_created_, the event count and terminated-worker tally, and a counter raised to
non-zero first.
