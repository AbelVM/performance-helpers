---
'performance-helpers': minor
---

Add optional `bytesAcknowledged` callback to `PowerRealtimeHub` subscriptions (WT-004).

`bytesAcknowledged` is a transport-reported per-stream callback the caller wires
up at `subscribe()` time. It reports bytes the transport has _acknowledged_ for
that subscriber, as opposed to bytes the hub handed over. On HTTP/2 it matches
the hub's own `bytesSent`; on transports that do not report it the callback is
simply not supplied and the hub keeps `bytesSent` as the floor.

The shape is a function rather than a number because the value moves: a number
captured at subscribe time would be stale by the next flush. The callback is
invoked **after** the transport has taken the frame, in the same statement that
increments `bytesSent`, so the two move together.

A new static `PowerRealtimeHub._validateAcknowledged(fn)` validates the callback
at subscribe time. It accepts `null` and `undefined` as the explicit "not
supplied" sentinel and returns `null` for both; anything that is not a function
throws `TypeError`. The check is extracted because it is its own branch and
because the error message needs to name the parameter.

The callback is stored on the `HubSubscriber` record as `bytesAcknowledged` and
invoked inside the existing `sub.bytesSent += frame.length` statement, wrapped
in `try/catch` so a bad accounting callback is reported through `_notify` rather
than taking the subscriber down.

7 tests in `test/powerRealtimeHub.bytesAcknowledged.test.js`, mutation-checked.
Two mutants were caught:

- removing the `_validateAcknowledged` call in `subscribe()` (2 failures);
- bypassing the callback invocation in `_flushSubscriber` (2 failures).

No breaking behaviour change; the default is no callback and `bytesSent` remains
the floor.
