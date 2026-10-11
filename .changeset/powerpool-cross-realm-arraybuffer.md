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

27 tests in `test/powerPool.prepareBuffers.test.js`, all driven by a real `node:vm`
second realm. They pin that a foreign buffer is transferred rather than encoded through
each reachable gate, that views remain correct, that plain objects are still encoded (the
branch the fix must not break), and that `awaitResponse` refuses a foreign buffer.

Mutation-checked **7 of 9** reverts killed by a named test. The two survivors are
`canBypassWrapper` and `isTransferListLive`, both on the bypass path, and both are a
limitation of the test fake rather than of the fix: the fake worker's `postMessage` is a
no-op that never throws, so a detached buffer is indistinguishable from a live one. The
path is reachable — `workers[0].worker` is a genuine `WorkerWrapper` with an
`_underlying`, and `_prepareForTransfer({ a: 1 }, [buf], {})` yields a plain-object
message with a two-element transfer list — so what is missing is a fake that reproduces
structured clone's throw-on-detached. Those two sites are fixed by the same substitution
as the other thirteen and verified by reasoning, not by an observed failure.

Lint is clean. The warning count went from 14 at `HEAD` to 13, because the `postMessage`
complexity warning disappeared when its body shrank.
