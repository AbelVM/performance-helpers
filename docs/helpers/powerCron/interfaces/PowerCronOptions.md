[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerCron](../README.md) / PowerCronOptions

# Interface: PowerCronOptions

## Properties

### catchUp?

> `optional` **catchUp?**: [`CatchUpPolicy`](../type-aliases/CatchUpPolicy.md)

What to do about fires missed
while the process was busy or asleep:

- `'skip'` (default) run once, immediately, then resume the normal cadence.
- `'catch-up'` replay every missed fire, in order, before resuming. Correct
  for jobs that must account for each period (billing, rollups).
- `'run-once'` coalesce all missed fires into a single run.

---

### intervalMs?

> `optional` **intervalMs?**: `number`

Milliseconds between fires. Must be
at least 10, so a typo cannot become a hot loop.

---

### jitter?

> `optional` **jitter?**: `number`

Random fraction (0–1) of the interval added
to each fire, spreading a fleet's crons so they do not stampede a
dependency on the same minute boundary.

---

### onError?

> `optional` **onError?**: (`err`) => `void`

Called when the task throws or
rejects. Errors are swallowed by default so one bad run does not kill the
schedule.

#### Parameters

##### err

`Error`

#### Returns

`void`

---

### onFire?

> `optional` **onFire?**: (`info`) => `void`

Called after each successful run
with `{ scheduledFor, ranAt, driftMs, missed }`.

#### Parameters

##### info

`Object`

#### Returns

`void`

---

### runOnStart?

> `optional` **runOnStart?**: `boolean`

Fire once immediately on `start()`,
then follow the normal cadence.

---

### unref?

> `optional` **unref?**: `boolean`

Whether the pending timer is `unref`'d, so
a running cron does not by itself keep a Node process alive.
