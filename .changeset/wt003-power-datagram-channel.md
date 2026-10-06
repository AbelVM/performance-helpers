---
'performance-helpers': minor
---

Add `PowerDatagramChannel` helper and change its queue behavior to drop-oldest (WT-003).

`PowerDatagramChannel` is a new realtime helper that multiplexes ordered datagram
streams over a single `MessagePort` or `BroadcastChannel`. It frames each datagram
with a 4-byte big-endian length prefix, assigns a per-stream sequence number, and
delivers out-of-order or late frames through a configurable `onError` callback
rather than silently dropping them.

The queue behavior changed from "refuse when full" to "drop-oldest then queue new
datagram". The previous behaviour back-pressured the sender by throwing, which is
the wrong contract for a datagram channel: a dropped datagram is already lost, so
the channel should make room for newer data rather than forcing the sender to
handle a synchronous throw on a path that is otherwise fire-and-forget. The queue
now has a fixed `maxSize` (default 256); when a new datagram would exceed it, the
oldest pending datagram is discarded and the new one is queued. `onError` is
invoked for the discarded datagram so accounting stays accurate.

New files:

- `src/helpers/powerDatagramChannel.js`
- `guides/powerDatagramChannel.md`

Wired into the public surface: `src/index.js`, `test/apiSurface.test.js`,
`guides/metaGuide.md`, `assets/5_Realtime.md`, `README.md`.

17 tests in `test/powerDatagramChannel.test.js`, covering send/receive, queue
overflow, drop-oldest behaviour, error callback, and close/drain semantics.

No breaking changes to existing helpers.
