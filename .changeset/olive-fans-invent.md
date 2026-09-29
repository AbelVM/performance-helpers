---
'performance-helpers': patch
---

Documents W3C trace propagation through `PowerPool`, and why it needs nothing
from the library.

`guides/traceContext.md` gives the recipe — a `traceparent` in the payload, the
worker echoes it, `als.run` per message on the worker side so nothing has to be
threaded through your own signatures — and the test that proves it
(`test/traceContext.test.js`).

The row this came from asked for trace propagation _in_ `PowerPool`. The reframe
is the finding: the pool already round-trips a field the caller names —
`correlationId` — and touches nothing else in a payload. A trace rides that same
path with no pool change, no option and no version.

The obvious alternative, a metadata channel in the frame, would break every
hand-written worker. The frame is a 6-byte header at protocol version 1, and
workers read those bytes directly; `examples/lib/worker.mjs` and every user's
worker included. Growing a per-message metadata concept into the pool also
moves toward the failure [adr/0001](../adr/0001-versioned-envelope-protocol.md)
was written to prevent: the 1.x decoder guessed at message content and misparsed
a payload that was valid as two different things.

Documentation only. No API change.
