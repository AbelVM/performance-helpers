# PowerHeartbeat

Jittered liveness detector for a peer that is expected to check in on a schedule. The helper owns the timer: it schedules a check at `interval` (plus jitter) and declares the peer dead when no `beat()` has arrived within `timeout`.

## When to use

- Detecting a dead WebSocket / SSE / datagram peer without waiting for a transport error
- Reaping idle connections in a hub or pool
- Any place a fleet of peers would otherwise fire their checks in lockstep

## Installation

```js
import { PowerHeartbeat } from 'performance-helpers/powerHeartbeat';
```

## API

### new PowerHeartbeat(options)

Options: `{ interval?, jitter?, timeout?, onTimeout?, onBeat?, now? }` or just `interval` (number).

- `interval` (number, ms): expected time between beats. Default 30000.
- `jitter` (number): fraction of `interval` in `0..1` applied to the _scheduled_ check. Default 0. A value above 1 throws, because it would schedule the next check in the past and invert the decorrelation into a busy loop.
- `timeout` (number, ms): silence after which the peer is declared dead. Defaults to `interval * 2`.
- `onTimeout` (function): called as `(missedBeats, lastBeatAt)` when a check finds no beat within `timeout`.
- `onBeat` (function): called as `(lastBeatAt)` on every `beat()`.
- `now` (function): injected clock, as the limiters take (PERF-007).

### Methods

- `start()` — Begin scheduling checks. Idempotent: a second call does not reset the deadline.
- `stop()` — Stop scheduling. Recorded state survives, so a `stop()`/`start()` pair resumes the same deadline.
- `beat()` — Record that the peer is alive. Resets the missed-beat counter and the deadline.
- `onTimeout(cb)` — Register or replace the timeout callback after construction.
- `isRunning()` — Whether checks are currently scheduled.
- `dispose()` / `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` — Clears the timer. This helper **owns a timer**, so this is not a state reset.

### Properties

- `missedBeats` — Consecutive checks that found no `beat()`.
- `lastBeatAt` — Timestamp of the last `beat()`, or `0` if there was none.
- `timedOut` — Whether the peer has been declared dead and has not since called `beat()`.

## Why jitter the schedule and not the deadline

A fleet of peers that all start from the same clock fires in lockstep, so the timeout checks — and any reconnect storm that follows a shared failure — arrive as one spike instead of a spread. Jittering the _scheduled_ interval by a fraction of itself decorrelates them without changing the mean rate.

The deadline is deliberately left alone: it is `timeout` after the last beat, so a peer that beats on time is never failed for arriving early. Only the polling cadence moves.

## Examples

```js
import { PowerHeartbeat } from 'performance-helpers/powerHeartbeat';

const hb = new PowerHeartbeat({
  interval: 5000,
  jitter: 0.2,
  timeout: 15000,
  onTimeout: (missed) => {
    console.log(`peer missed ${missed} checks — reaping`);
    socket.close();
  },
});

hb.start();
socket.addEventListener('message', () => hb.beat());
```

```js
// Deterministic tests: inject the clock, drive it by hand.
let t = 0;
const hb = new PowerHeartbeat({ interval: 100, timeout: 250, now: () => t });
hb.start();
hb.beat();
t = 249;
// …one check fires, peer is still inside the deadline
t = 250;
// …next check declares the peer dead
```

```js
// Takes part in `using` / `await using` teardown like every other
// long-lived helper here.
{
  using hb = new PowerHeartbeat({ interval: 1000 });
  hb.start();
} // timer cleared here
```
