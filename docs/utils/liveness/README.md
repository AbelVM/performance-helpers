[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / utils/liveness

# utils/liveness

The reply half of a protocol-level heartbeat, shared by `PowerWebSocketClient` and
`PowerSocketAdapter`.

**RT-016.** These two classes grew independent heartbeat implementations, and the row
that asked for them to be unified described them as one-correct and one-broken. That
was stale twice over: `RT-003` fixed the client, and after the adapter's four-line
`_handlePong` was brought up to the same behaviour the two had *converged* — same
deadline-only clear, same timestamp bookkeeping, same guard. At that point the honest
description was not "one is broken" but "there are two copies", and a shared function
is the whole of the fix.

**Why the deadline clear and the measurement are one function.** They are not two
steps. The clear settles *one outstanding probe*, and the measurement is the RTT of
*that same probe* — reading the timestamp is meaningless if the deadline that would
have fired on it is still armed, and clearing it is meaningless if the reading is
dropped. Splitting them is how the two classes came to disagree.

**Why `clearDeadline` is a callback and not a handle.** The helper does not own the
timer, so it cannot null the field that holds it; passing the handle would mean the
caller cleared afterwards and the "one outstanding probe" rule would live in two
places again. The callback keeps the clear and the read in the same expression.

The guards are the client's, verbatim, and each earned its place:

- **`if (!sentAt) return`** — a pong arriving with no probe outstanding (a late reply
  to a probe already settled) is not a measurement of anything.
- **`if (!(rtt >= 0)) return`** — a clock that went backwards is not a measurement.
  Written as a negated comparison rather than `rtt < 0` because `NaN` also fails it,
  and a `NaN` sample silently poisons a percentile series.

## Functions

- [settleHeartbeatProbe](functions/settleHeartbeatProbe.md)
