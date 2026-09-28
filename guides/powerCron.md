# PowerCron

A drift-free cron-like scheduler built on `setTimeout` chaining.

```js
import { PowerCron } from 'performance-helpers/powerCron';

const cron = new PowerCron(() => collectMetrics(), { intervalMs: 60_000 });
cron.start();

// later
cron.stop(); // or cron.dispose()
```

## Why not `setInterval`

`setInterval` does not mean "every N ms". It means "every N ms after the previous
callback **returns**", which has two consequences that only show up in production:

- **Phase error accumulates without bound.** A job nominally on the minute
  drifts seconds per hour and is no longer "on the minute" by the end of the day.
- **Missed fires queue up.** A 1 s job on a 5 s interval that stalls for 30 s
  fires six times in a row the moment it resumes, against a dependency that is
  already struggling.

`PowerCron` re-arms from an **absolute target** instead. Each run records the
time it was *aimed at*, and the next timer is computed from that target rather
than from `Date.now()`. Drift therefore cannot accumulate: a run that takes
800 ms of a 1 s interval still leaves the next fire 200 ms away, not 800 ms away.
A run that overran its interval skips the periods it missed, so it never
queues.

Drift is observable rather than folklore — `averageDriftMs` and `fireCount` are
there so a schedule that cannot keep up says so.

## API

### `new PowerCron(task, options?)`

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `task` | `() => any` | — | Run on each fire. May be async. **Required.** |
| `intervalMs` | `number` | `60000` | Milliseconds between fires. Must be at least `10`, so a typo cannot become a hot loop. |
| `catchUp` | `'skip' \| 'catch-up' \| 'run-once'` | `'skip'` | What to do about fires missed while the process was busy or asleep (see below). |
| `jitter` | `number` | `0` | Random fraction (0–1) of the interval added to each fire, so a fleet's crons do not stampede a dependency on the same boundary. Clamped to `[0, 1]`. |
| `runOnStart` | `boolean` | `false` | Fire once immediately on `start()`, then follow the cadence. |
| `onError` | `(err) => void` | — | Called when the task throws or rejects. Without it, errors are logged. |
| `onFire` | `(info) => void` | — | Called after each run with `{ scheduledFor, ranAt, driftMs, missed }`. |
| `unref` | `boolean` | `true` | Whether the pending timer is `unref`'d, so a cron alone does not keep a Node process alive. |

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `start()` | `this` | Arm the schedule. Idempotent. |
| `stop()` | `this` | Disarm. Idempotent. A task already in flight is left to finish — cancelling it would abandon work that may hold resources. |
| `runNow()` | `this` | Fire immediately, out of band, without disturbing the cadence. |
| `dispose()` | `void` | `stop()`, permanently. Also available as `[Symbol.dispose]`, so `using cron = new PowerCron(…)` stops the schedule at scope exit. |

### Properties

| Property | Type | What it is |
| --- | --- | --- |
| `running` | `boolean` | Whether the schedule is armed. |
| `intervalMs` | `number` | The configured interval. |
| `fireCount` | `number` | How many times the task has been invoked, **including `catch-up` replays**. |
| `averageDriftMs` | `number` | Mean lateness per fire; `0` before anything has run. A growing mean means the task cannot keep up. |
| `nextRunAt` | `number \| null` | Epoch ms the next fire is aimed at; `null` when stopped. |

## Catch-up policy

What happens to fires missed while the process was busy or asleep is a
**policy decision**, not a scheduling detail, so it is an option:

- `'skip'` (default) — run once, immediately, then resume the normal cadence.
- `'catch-up'` — replay every missed fire, in order, before resuming. Correct
  for work that must account for each period (billing, hourly rollups). The
  replays are included in `fireCount`, so a caller can see that a replay
  happened rather than assume a single resume.
- `'run-once'` — coalesce all missed fires into one run. `fireCount` still
  accounts for the periods covered, so the work skipped is visible.

## Errors do not kill the schedule

A throwing task, a rejected promise, or a throwing `onFire` is routed to
`onError` and the schedule continues. This is deliberate: an unhandled rejection
from a timer callback takes the process down, so without this "one run threw"
would silently become "the cron is dead" — or "the server is dead", depending
on the host. With no `onError` configured, errors are logged rather than dropped.

## Notes

- **The first fire is one interval from `start()`, not a wall-clock boundary.**
  A cron started at 10:00:37 with a 60 s interval fires at 10:01:37. Aligning to
  the top of the minute is deliberately not done: a shared boundary is the
  single largest source of thundering herd in a fleet, and `jitter` is there for
  callers who want some of that back.
- **`unref` defaults to `true`.** A library that silently keeps the Node event
  loop open turns every "run this every minute" script into something that needs
  `process.exit()`. Pass `unref: false` if the cron alone should hold the process
  open.
- **Not a calendar cron.** There is no `@daily` parsing, no timezone handling and
  no overlap policy — this is an interval scheduler that does not drift. Compose
  it with a wall-clock check inside the task if calendar semantics are needed.

## See also

- [PowerScheduler](powerScheduler.md) — microtask/macrotask coalescing for
  per-microtask work, where you want *one* flush per turn rather than a cadence.
- [PowerThrottle](powerThrottle.md) and [PowerRateLimit](powerRateLimit.md) —
  rate limiting, if what you actually want is "not more than N per second"
  rather than "every N".
