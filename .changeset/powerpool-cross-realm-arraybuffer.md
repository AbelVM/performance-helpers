---
'performance-helpers': patch
---

### Fixed

`PowerPool` encoded a cross-realm `ArrayBuffer` instead of transferring it, in
**fifteen** places.

`instanceof` compares against _this_ realm's prototype, so a buffer from a `node:vm`
sandbox, an iframe or a worker failed every `instanceof ArrayBuffer` test in the file.
The consequence was not corruption — the data survived, because `_encodeForTransfer`
reads the bytes correctly for a foreign buffer — but the buffer was JSON-encoded and
structured-cloned rather than moved, so the zero-copy path was silently lost.

Measured before the fix, under every codec (`legacy`, `framed`, `negotiated`) and both
entry points (`prepareBuffers`, `_prepareForTransfer`): a same-realm buffer came back as
`{ message: <the buffer>, transfer: [<the buffer>] }` and a cross-realm one as
`{ message: <encoded>, transfer: undefined }`. After the change the two are identical.

**Views were never affected.** `ArrayBuffer.isView` is realm-independent, and every site
checks it alongside the `instanceof`, so a cross-realm `Uint8Array` took the binary branch
correctly all along. That asymmetry is what made this survive: the views were covered, and
the file read as covered.

The triage that found these established reachability by measurement rather than by
pattern, and the split matters for reading the diff:

- **The gates** — `prepareBuffers`, `_prepareForTransfer`, `WorkerWrapper.postMessage`,
  `broadcast`, `awaitResponse` and `canBypassWrapper` — are where a foreign buffer was
  misclassified as a plain object. These are the sites that fire.
- **The downstream sites** — the `transferTarget` selections and the zero-length copy —
  are unreachable for a foreign buffer, because the gate ahead of them never passes. They
  are converted for consistency, not because they were reachable.
- **The inbound site** (`_handleMessage`) is unreachable by construction: structured clone
  produces a same-realm buffer in the receiving realm.

`awaitResponse` is the one site whose failure was data loss rather than a lost
optimisation. It augments the message with a `correlationId` via `Object.assign`, which is
only safe for a plain object; applied to a buffer it produces `{ correlationId }` and the
payload is gone. It now refuses a foreign buffer exactly as it already refused a
same-realm one.

### Tests

29 tests in `test/powerPool.prepareBuffers.test.js`, all driven by a real `node:vm`
second realm. They pin that a foreign buffer is transferred rather than encoded through
each reachable gate, that views remain correct, that plain objects are still encoded (the
branch the fix must not break), and that `awaitResponse` refuses a foreign buffer.

Mutation-checked **9 of 9** reverts killed by a named test.

The last two needed a different approach, and the reason is worth recording.
`canBypassWrapper` and `isTransferListLive` both guard the dispatch fast path that posts
straight to the underlying worker, skipping the `WorkerWrapper`'s transfer-list
normalisation. The first attempt at testing them failed for a reason that had nothing to
do with the defect: a no-op fake worker cannot tell a detached buffer from a live one, so
the two paths were indistinguishable. The observable that works is **which path ran** —
the bypass never reaches `_dispatchToWorker`, the wrapper path always does — so a spy on
`_dispatchToWorker` separates them without needing the fake to throw.

Those two are also called directly rather than through `postMessage`, because the public
API cannot isolate either condition: it encodes a bare `ArrayBuffer` into a `Uint8Array`,
so `ArrayBuffer.isView` blocks the bypass for a reason unrelated to the site under test,
and the assertion would pass with the defect present. Constructing the prepared item
isolates one condition at a time. The `isTransferListLive` case has the cleanest control
pair in the file — the same shape with a live buffer takes the bypass, with a detached one
does not, so the detached state is unambiguously the deciding condition.

Lint is clean. The warning count went from 14 at `HEAD` to 13, because the `postMessage`
complexity warning disappeared when its body shrank.
