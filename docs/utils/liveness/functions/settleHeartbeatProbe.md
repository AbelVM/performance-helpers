[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/liveness](../README.md) / settleHeartbeatProbe

# Function: settleHeartbeatProbe()

> **settleHeartbeatProbe**(`probe`): `number` \| `null`

Settle one outstanding heartbeat probe: clear its deadline, and record the RTT if a
probe was actually outstanding.

## Parameters

### probe

#### clearDeadline

() => `void`

Clear the outstanding probe's timer and
  forget its handle. Called **before** the measurement is taken, and whether or not a
  probe was outstanding.

#### now

`number`

The current reading, from the same clock that sent it.

#### onHeartbeat?

() => `void`

Called once, only when a sample is recorded.

#### pingSentAt

`number`

When the probe was sent; `0` for none.

#### record?

(`rtt`) => `void`

Receives the RTT. Called only when a
  sample is recorded.

## Returns

`number` \| `null`

The measured RTT, or `null` when no sample was taken — which is
  the answer for a stray pong, a backwards clock, and an outstanding count of zero.
