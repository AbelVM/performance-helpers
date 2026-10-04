[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/liveness](../README.md) / sendHeartbeatProbe

# Function: sendHeartbeatProbe()

> **sendHeartbeatProbe**(`probe`): `boolean`

Send one heartbeat probe, and arm its deadline if one was sent.

**The one behaviour that was not already shared, and the reason this function exists
rather than a merge.** The two classes disagreed on what a throwing `ping()` means:
`PowerSocketAdapter` reported it and returned, so no deadline was armed;
`PowerWebSocketClient` reported it and fell through, so a deadline was armed against a
probe that had never gone out. A deadline that fires with nothing outstanding reports a
transport dead that may not be — so **arming on a failed send is the worse of the two**,
and that is the behaviour both classes now have.

The reasoning, so the decision is arguable rather than merely asserted: a failed `ping()`
means the transport is already broken, and the honest report is the error, not a timeout
against a probe nobody will answer. A liveness signal that fires spuriously is worse
than one that fires late, because it closes a healthy connection.

The deadline is also armed **once per live window** — never while one is outstanding.
Two bugs live in that condition, both measured on a socket whose `ping()` is never
answered: re-arming without clearing orphaned one timer per tick (three ticks, three
deadlines, zero cleared), and *clearing and re-arming* means a socket that never answers
never times out at all whenever `heartbeatTimeoutMs` exceeds `heartbeatIntervalMs`,
because the deadline would keep measuring from the latest ping rather than the first.

## Parameters

### probe

#### arm?

() => `void`

Arms the deadline. Only reached when a probe was sent.

#### canPing

`boolean`

Whether the transport exposes a usable `ping()`. When
  `false` nothing is sent, nothing is armed, and `false` is returned: a browser does not
  expose `ping()` by design, and inventing a probe there would be a lie.

#### hasOutstanding?

() => `boolean`

Whether a deadline is already armed.

#### markSent?

(`now`) => `void`

Records the send time, before the
  ping goes out, so a synchronous reply still finds it.

#### now

`number`

The clock reading to record as the send time.

#### onPingError?

(`err`) => `void`

Receives a throw from `ping()`.
  The error is reported and **no deadline is armed**.

#### ping

() => `void`

Sends the probe. May throw.

#### timeoutMs

`number`

`0` disables the deadline entirely.

## Returns

`boolean`

`true` when a probe was sent, `false` otherwise — including when
  `ping()` threw, which is why callers cannot infer "armed" from the return.
