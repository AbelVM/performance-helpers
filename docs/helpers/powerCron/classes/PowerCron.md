[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCron](../README.md) / PowerCron

# Class: PowerCron

A drift-free cron-like scheduler built on `setTimeout` chaining.

**Why not `setInterval`.** `setInterval` does not mean "every N ms". It means
"every N ms after the previous callback *returns*", so a run that takes longer
than the interval pushes every subsequent fire later, and the phase error
accumulates without bound — a job nominally on the minute drifts seconds per
hour and is no longer "on the minute" by the end of the day. Long callbacks
also queue up: a 1 s job on a 5 s interval that stalls for 30 s fires six
times in a row on resume.

This scheduler re-arms from an absolute target instead. Each run records the
fire time it was *aimed at*, and the next timer is computed from that target
rather than from `Date.now()`. Drift therefore cannot accumulate: a run that
takes 800 ms of a 1 s interval still leaves the next fire 200 ms away, not
800 ms away.

Skipping a whole interval (`Math.floor(elapsed / interval) + 1`) is what keeps
a stalled run from immediately re-firing. What happens to the fires that were
missed in between is a policy decision, not a scheduling detail, so it is an
option — see [PowerCronOptions.catchUp](../interfaces/PowerCronOptions.md#catchup).

 PowerCron

## Example

```ts
const cron = new PowerCron(() => collectMetrics(), { intervalMs: 60_000 });
cron.start();
// later
cron.stop();
```

## Constructors

### Constructor

> **new PowerCron**(`task`, `options?`): `PowerCron`

#### Parameters

##### task

() => `any`

The function to run on each fire. May be async;
  a rejected promise is routed to `onError` and does not stop the schedule.

##### options?

[`PowerCronOptions`](../interfaces/PowerCronOptions.md) = `{}`

#### Returns

`PowerCron`

## Properties

### \_catchUp

> **\_catchUp**: `"skip"` \| `"catch-up"` \| `"run-once"`

***

### \_intervalMs

> **\_intervalMs**: `number`

***

### \_jitter

> **\_jitter**: `number`

***

### \_maxCatchUp

> **\_maxCatchUp**: `number`

***

### \_nextAt

> **\_nextAt**: `number`

Absolute timestamp the next fire is aimed at.

***

### \_onError

> **\_onError**: ((`err`) => `void`) \| `null`

***

### \_onFire

> **\_onFire**: ((`info`) => `void`) \| `null`

***

### \_overlap

> **\_overlap**: `boolean`

***

### \_running

> **\_running**: `boolean`

***

### \_runOnStart

> **\_runOnStart**: `boolean`

***

### \_task

> **\_task**: () => `any`

#### Returns

`any`

***

### \_timer

> **\_timer**: `any`

***

### \_unref

> **\_unref**: `boolean`

## Accessors

### averageDriftMs

#### Get Signature

> **get** **averageDriftMs**(): `number`

Mean drift in ms per fire — 0 when nothing has run yet. A schedule that
cannot keep up shows a growing mean, which is the signal to raise the
interval or shorten the task.

##### Returns

`number`

***

### fireCount

#### Get Signature

> **get** **fireCount**(): `number`

##### Returns

`number`

How many times the task has been invoked.

***

### intervalMs

#### Get Signature

> **get** **intervalMs**(): `number`

##### Returns

`number`

The configured interval, in ms.

***

### nextRunAt

#### Get Signature

> **get** **nextRunAt**(): `number` \| `null`

##### Returns

`number` \| `null`

Epoch ms the next fire is aimed at.

***

### running

#### Get Signature

> **get** **running**(): `boolean`

##### Returns

`boolean`

Whether the schedule is armed.

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal hook (thin wrapper). Forwards to sync disposal.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Alias for [PowerCron#dispose](#dispose-1), so `using cron = new PowerCron(...)`
stops the schedule at scope exit.

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

Stop the schedule for good.

#### Returns

`void`

***

### runNow()

> **runNow**(): `PowerCron`

Fire immediately, out of band, without disturbing the cadence.

#### Returns

`PowerCron`

***

### start()

> **start**(): `PowerCron`

Arm the schedule. Idempotent.

With `runOnStart`, the task fires immediately and the cadence is anchored
to that moment. Without it, the first fire is one interval from now — so a
cron started at 10:00:37 with a 60 s interval fires at 10:01:37, not
10:01:00. Aligning to wall-clock boundaries is deliberately not done: a
shared "top of the minute" is the single largest source of thundering herd
in a fleet, and `jitter` exists for callers who want some of that back.

#### Returns

`PowerCron`

***

### stop()

> **stop**(): `PowerCron`

Disarm the schedule. Idempotent.

A task already in flight is left to finish — cancelling it would mean
abandoning work that may hold resources, and there is no way to interrupt a
synchronous task anyway.

#### Returns

`PowerCron`
