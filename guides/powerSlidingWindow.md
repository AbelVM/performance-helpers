# PowerSlidingWindow

A sliding-window rate limiter that allows up to `capacity` events per `windowMs`.

## Constructor

| option     |                 type |   default | description                                                                                        |
| ---------- | -------------------: | --------: | -------------------------------------------------------------------------------------------------- |
| `capacity` |             `number` |       `1` | Maximum allowed events in a window.                                                                |
| `windowMs` |             `number` |    `1000` | Window size in milliseconds.                                                                       |
| `now`      | `function(): number` | `nowMs()` | Clock override in ms. Ignores any per-call value a composition threads in — see [Clocks](#clocks). |

## API

- `tryConsume(n = 1)` — Attempt to consume `n` slots (default `1`) in the current rolling window. Returns `true` when the requested slots are available and the call consumes them; otherwise returns `false`. A `n` that is not a finite number throws a `TypeError`; see [Request counts](#request-counts).

- `available()` — Return the current number of available slots in the window. This performs a prune of stale timestamps before reporting.

- `reset()` — Clear internal state and timestamp queue, effectively refilling the window. **The ring buffer is kept**, so this is cheap enough for a hot path; see [reset versus dispose](#reset-versus-dispose).

- `dispose()` — Release everything the instance holds, including the ring buffer. Use at teardown, including `using` / `await using` scope exit.

## Reset versus dispose

Both empty the window; they differ in what happens to the memory.

|             | `reset()`                    | `dispose()`                          |
| ----------- | ---------------------------- | ------------------------------------ |
| history     | dropped                      | dropped                              |
| ring buffer | **kept** at its current size | **released** to its initial capacity |
| clock       | untouched                    | untouched                            |
| for         | a live window being cleared  | an instance you have finished with   |

The window keeps one timestamp per admitted request in a `PowerQueue`, and that
queue **grows**: a window that admits 5000 requests holds a ring of 8192 slots.
`dispose()` returns it, so a helper you have finished with is not still holding
its largest allocation. `reset()` deliberately does not, because it puts a
_live_ window back to empty — a caller clearing a per-tenant window between
requests would then reallocate the ring on every call, trading a retained buffer
for repeated allocation on a path that is already hot.

Neither touches the clock. A clock you injected with `now:` is **your** function,
and `dispose()` releasing resources is not a licence to swap out caller
configuration underneath it.

## Request counts

`tryConsume` **validates** its count argument rather than coercing it. It used to run it through `Math.max(0, Math.floor(n) || 0)`, which turns `NaN` into `0` — and `0` is the _admit_ case, so `tryConsume(NaN)` returned `true` having recorded nothing at all.

| Input                           | Behaviour             |
| ------------------------------- | --------------------- |
| non-finite (`NaN`, `±Infinity`) | throws `TypeError`    |
| not a number (`'many'`)         | throws `TypeError`    |
| fractional (`3.9`)              | floors to `3`         |
| numeric string (`'3'`)          | read as `3`           |
| `0` or negative                 | no-op, returns `true` |

A fractional count floors rather than throwing, unlike a fractional **option**: a fractional `capacity` would be rounded up by its first consumer and over-admit, while a request count rounds down and can only under-charge.

## Example

```javascript
import { PowerSlidingWindow } from '../src/helpers/powerSlidingWindow.js';
import { PowerPool } from '../src/index.js';

const limiter = new PowerSlidingWindow({ capacity: 5, windowMs: 1000 });
if (limiter.tryConsume()) {
  // allowed
} else {
  // rate limited
}
```

### Example: cooperating with `PowerPool`

Use a `PowerSlidingWindow` to cap how many tasks you dispatch into a `PowerPool` within a rolling window. This example enqueues tasks and keeps a `pending` list for items that must wait until quota becomes available.

```javascript
const limiter = new PowerSlidingWindow({ capacity: 2, windowMs: 1000 });
const pool = new PowerPool(MyWorker, { size: 2 });

const pending = [];
function scheduleTask(payload) {
  if (limiter.tryConsume()) {
    pool.postMessage({ task: 'do', payload });
  } else {
    pending.push(payload);
  }
}

for (let i = 0; i < 10; i++) scheduleTask({ i });

// Periodically attempt to drain pending tasks when the window slides.
const interval = setInterval(() => {
  while (pending.length && limiter.tryConsume()) {
    pool.postMessage({ task: 'do', payload: pending.shift() });
  }
  if (!pending.length) clearInterval(interval);
}, 200);

await pool.drain();
pool.terminate();
```

## Clocks

Every limiter reads time, and `nowMs()` is not cheap: it reads **two** clocks
per call — the high-resolution one and `Date.now()`, the second purely to check
the two have not diverged under a test harness — and measures about **141 ns**.
Against a whole `tryConsume` of ~120-165 ns, deciding what time it is was most
of the work.

Two knobs address that, and they are deliberately not symmetric:

| Where                     | Type                 | Used by                                                |
| ------------------------- | -------------------- | ------------------------------------------------------ |
| `now` constructor option  | `function(): number` | tests, and any caller driving a fake clock             |
| `{ now }` per-call option | `number`             | `PowerRateLimit`, threading one reading into every leg |

**A limiter constructed with its own `now` ignores any per-call value.** An
explicitly injected clock always wins. The reason is not precedence taste: a
limiter built with a fake clock is a limiter _under test_, and if a composition
overrode its notion of time mid-run, the test would silently start measuring
something else. That is the hardest kind of failure to notice, and it happens
exactly when you are most likely to be looking for a different bug.

A limiter that takes no second argument simply reads its own clock, which is
why threading needs no capability check on the limiter and works with
third-party limiters unchanged.

```javascript
// A driven clock, for anything deterministic.
let clock = 0;
const throttle = new PowerThrottle({ capacity: 10, refillRate: 100, now: () => clock });

// One reading, shared by every leg of a composition.
rateLimit.tryConsume(1, { now: Date.now() });
```

Note the sharp edge: a threaded `now` is **authoritative**, so a value far in the
future will legitimately empty a sliding window. That is correct — it is what a
real clock jumping would do — but it is why a caller should thread one instant
for the whole composition rather than letting each leg drift.
