[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerHeartbeat](../README.md) / PowerHeartbeat

# Class: PowerHeartbeat

PowerHeartbeat

Liveness detector for a peer that is expected to check in on a schedule.
The helper owns the timer: it schedules a check at `interval` (plus jitter)
and declares the peer dead when no `beat()` has arrived within `timeout`.

The jitter is the reason this exists rather than a bare `setInterval`. A
fleet of peers that all start from the same clock fires in lockstep, so the
timeout checks - and any reconnect storm that follows a shared failure -
arrive as one spike instead of a spread. Jittering the *scheduled* interval
by a fraction of itself decorrelates them without changing the mean rate.

 PowerHeartbeat

## Constructors

### Constructor

> **new PowerHeartbeat**(`options?`): `PowerHeartbeat`

#### Parameters

##### options?

`number` \| `PowerHeartbeatOptions`

#### Returns

`PowerHeartbeat`

## Properties

### \_disposed

> **\_disposed**: `boolean`

***

### \_interval

> **\_interval**: `number`

***

### \_jitter

> **\_jitter**: `number`

***

### \_lastBeatAt

> **\_lastBeatAt**: `number`

***

### \_missedBeats

> **\_missedBeats**: `number`

***

### \_now

> **\_now**: () => `number`

#### Returns

`number`

***

### \_onBeat

> **\_onBeat**: ((`lastBeatAt`) => `void`) \| `null`

***

### \_onTimeout

> **\_onTimeout**: ((`missedBeats`, `lastBeatAt`) => `void`) \| `null`

***

### \_running

> **\_running**: `boolean`

***

### \_timedOut

> **\_timedOut**: `boolean`

***

### \_timeout

> **\_timeout**: `number`

***

### \_timer

> **\_timer**: `number` \| `null`

## Accessors

### lastBeatAt

#### Get Signature

> **get** **lastBeatAt**(): `number`

##### Returns

`number`

Timestamp of the last `beat()`, or `0` if there was none.

***

### missedBeats

#### Get Signature

> **get** **missedBeats**(): `number`

##### Returns

`number`

Consecutive checks that found no `beat()`.

***

### timedOut

#### Get Signature

> **get** **timedOut**(): `boolean`

##### Returns

`boolean`

Whether the peer has been declared dead and has not
  since called `beat()`.

## Methods

### \_check()

> **\_check**(): `void`

#### Returns

`void`

***

### \_clearTimer()

> **\_clearTimer**(): `void`

#### Returns

`void`

***

### \_nextDelay()

> **\_nextDelay**(): `number`

The next delay, jittered.

Jitter is applied to the *scheduled* interval rather than to the deadline,
so a peer that beats on time is never failed for arriving early: the
deadline is `timeout` after the last beat, and only the polling cadence
moves.

#### Returns

`number`

***

### \_schedule()

> **\_schedule**(): `void`

#### Returns

`void`

***

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### beat()

> **beat**(): `void`

Record that the peer is alive. Resets the missed-beat counter and the
deadline, and fires `onBeat` when one was configured.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Release the timer.

This helper **owns a timer**, so `dispose()` clears it - it is not a state
reset. The distinction matters for `using` / `await using`: a heartbeat
left scheduled after its owner is gone keeps the event loop alive and
keeps firing a callback into a torn-down object.

#### Returns

`void`

***

### isRunning()

> **isRunning**(): `boolean`

#### Returns

`boolean`

Whether checks are currently scheduled.

***

### onTimeout()

> **onTimeout**(`cb`): `void`

Register the timeout callback after construction.

Exists because the option form is awkward for the common case: the
heartbeat is usually built before the object that knows how to react to a
dead peer, and threading a closure through the constructor inverts that
dependency.

#### Parameters

##### cb

(`missedBeats`, `lastBeatAt`) => `void`

#### Returns

`void`

***

### start()

> **start**(): `void`

Begin scheduling liveness checks. Idempotent: a second `start()` on a
running heartbeat does not reset the schedule, because the caller that
re-enters `start()` after a reconnect would otherwise silently postpone
the deadline it is trying to enforce.

#### Returns

`void`

***

### stop()

> **stop**(): `void`

Stop scheduling checks. The recorded state (`missedBeats`, `lastBeatAt`)
survives, so a `stop()`/`start()` pair resumes the same deadline rather
than granting the peer a fresh one.

#### Returns

`void`
