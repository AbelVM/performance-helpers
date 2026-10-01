---
'performance-helpers': minor
---

Four defects found by probing the shipped surface rather than reading it. Two were
silent message loss, one was a feature that reported the wrong thing, and one was
a fix from an earlier release that had introduced a failure of its own.

**`PowerScheduler` — `dispose()` on one macrotask scheduler used to wedge every
other one, permanently**

The macrotask channel is module-level, so it is shared. `dispose()` closes it,
which was correct in isolation — a started `MessagePort` keeps a Node process
alive forever, and `unref()` alone does not stop that once the ports are open.
But "release the channel" meant "release it for the whole process", so disposing
one scheduler tore the listener off every *other* scheduler's pending flush. The
message was discarded, `_run()` never ran, and `scheduled` stayed `true` — which
makes `schedule()` short-circuit on its first line forever after. Only `cancel()`
recovered it, and nothing documented that.

Measured before the fix: two macrotask schedulers, `a.schedule()`, `b.schedule()`,
`b.dispose()` before delivery — `a` flushed **0** times, and `a.scheduled` was
still `true` after three further `schedule()` calls. The trigger is the `using`
pattern the class advertises through `[Symbol.dispose]`.

Posts in flight are now counted, and `dispose()` drops the module reference but
**only closes the ports when nothing is pending**. The next scheduler builds a
fresh pair; the pending post is still delivered on the old, already-`unref()`ed
one, so nothing holds the process open. Disposing on an idle path closes the
ports exactly as before, and a subprocess that schedules and disposes still exits
cleanly.

Worth naming: this was introduced by RES-005 / F-53, the fix for a real and
separate process-hang bug. Both were real; the second only showed once two
schedulers shared a process.

**`PowerTTLMap` — a `ttl` that was not a number made an entry immortal**

`PowerCache` was repaired for this (CACHE-003) by extracting its check into
`powerCache.js` — which **exports nothing**, so `PowerTTLMap` could not reach it
and kept `Number(ttl) || 0`. The defect survived the fix, in the class next door.

```js
new PowerCache().set('k', 1, { ttl: 'abc' });   // TypeError, naming the value
new PowerTTLMap().set('k', 1, 'abc');            // stored expiresAt === 0
```

`0` is this class's "no expiry" sentinel, so a typo produced an entry that never
expires — silent, unbounded, and indistinguishable from correct behaviour. `[]`,
`true` and `NaN` did the same, and a **negative** TTL granted the same immortality.

The validator now lives in `utils/options.js` as one shared `normalizeTtl`, used
by both classes, so the next change to it lands on both. `PowerTTLMap` accepts a
number, a numeric string (still legitimate — `process.env.TTL` is a string) and
the `{ ttl }` object form; `Infinity`, `null`/`undefined` and `0` still mean no
expiry; everything else throws a `TypeError`, and a negative TTL a `RangeError`.
`{}` still means "use `defaultTTL`".

**This is a behaviour change.** Callers who were passing a computed TTL that can
be `NaN` will now get a `TypeError` where they previously got an entry that never
expired. That is the same trade `PowerCache` already makes, and the alternative —
silently keeping an immortal entry — is worse, but it is a throw at a call site
that used to succeed.

**`PowerGCRA.onError` fired on every ordinary refusal**

The predicate was `now < this._tat`, and a TAT ahead of `now` is not a clock
fault: it is the limiter's **normal saturated state**, and exactly what a
rate-limiting limiter looks like while it is working. Measured at
`rate: 1, capacity: 1`, **19 refusals produced 19 `onError` calls**, each carrying
a raw number rather than an `Error`, on a clock that never moved. So a correctly
rate-limiting limiter looked broken to anything watching, and a genuine backwards
clock step was indistinguishable from the noise.

The option is documented as reporting a misbehaving clock, so it now compares
against the last reading taken rather than against the TAT: a real backwards step
reports once, ordinary refusals report nothing, and the first reading after
construction reports nothing (there is no previous one to compare against). Still
never throws, and still guarded so a throwing handler cannot break admission.

**`PowerLatch.reset(count)` accepted what its own constructor rejects**

The constructor runs `assertLimitRequired(count, { integer: true })` and throws on
`2.5`; `reset()` ran `Math.max(0, Number(count) || 0)`. A fraction is not a smaller
latch, it is a latch that **cannot finish**: `reset(2.5)` then one `countDown()`
leaves `1.5` and `wait()` never settles. In the other direction `NaN` and `-5` both
collapsed to `0`, which *resolved* every pending waiter — a bad argument
fabricating completion out of a latch nobody had counted down. `reset()` now uses
the same validator, and a rejected count leaves the latch untouched.