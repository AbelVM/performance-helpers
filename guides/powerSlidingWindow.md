# PowerSlidingWindow

A sliding-window rate limiter that allows up to `capacity` events per `windowMs`.

## Constructor

| option          |                                          type |    default | description                                                                                        |
| --------------- | --------------------------------------------: | ---------: | -------------------------------------------------------------------------------------------------- |
| `capacity`      |                                      `number` |        `1` | Maximum allowed events in a window.                                                                |
| `windowMs`      |                                      `number` |     `1000` | Window size in milliseconds.                                                                       |
| `now`           |                          `function(): number` | `monoMs()` | Clock override in ms. Ignores any per-call value a composition threads in — see [Clocks](#clocks). |
| `observability` | `boolean` \| [`MetricsCollector`](metrics.md) |    `false` | Opt in to metrics. Off by default. See [Metrics](#metrics).                                        |

## API

- `tryConsume(n = 1)` — Attempt to consume `n` slots (default `1`) in the current rolling window. Returns `true` when the requested slots are available and the call consumes them; otherwise returns `false`. A `n` that is not a finite number throws a `TypeError`; see [Request counts](#request-counts).

- `available()` — Return the current number of available slots in the window. This performs a prune of stale timestamps before reporting.

- `reset()` — Clear internal state and timestamp queue, effectively refilling the window. **The ring buffer is kept**, so this is cheap enough for a hot path; see [reset versus dispose](#reset-versus-dispose).

- `dispose()` — Release everything the instance holds, including the ring buffer. Use at teardown, including `using` / `await using` scope exit.

- `stats()` — Serializable snapshot of `{ capacity, windowMs, used, available }`. **It prunes first**, so `used` reflects the window as of _now_. See [Metrics](#metrics).

- `getStats()` — Alias for `stats()`.

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

Every limiter reads time, and the clock it reads is **`monoMs()`, not
`nowMs()`** (RES-019). The full explanation — why `monoMs()` is cheaper, why
`nowMs()` is two reads, and why an injected `now` wins over everything — is in
[PowerThrottle → Clocks](powerThrottle.md#clocks). The summary here is the part
that is specific to this helper:

- The `now` constructor option lets tests and fake-clock callers drive the
  window deterministically.
- A limiter constructed with its own `now` ignores any per-call value. That is
  not precedence taste: a limiter built with a fake clock is a limiter _under
  test_, and a mid-run override would silently start measuring something else.

## Metrics

```javascript
const window = new PowerSlidingWindow({ capacity: 1000, windowMs: 60_000, observability: true });
```

Off by default. See [`metrics.md`](metrics.md).

**`stats()` prunes before it reports.** Nothing evicts an expired timestamp
except a prune, so a window that has gone quiet still holds every entry it ever
recorded. Reading the queue length directly would report a window as full long
after the events behind it fell out — wrong in the same direction as a stale token
count on `PowerThrottle`, and for the same reason.

Pruning here is **not** strictly read-only, and that is safe to say plainly: it
can only remove timestamps that have already left the window, so it cannot change
any future admission decision. `available()` has pruned on every read for the same
reason and longer, so this is not a new hazard.

**There are no allow/refuse counters**, for the same reason as on every other
helper here: a field increment on `tryConsume` is cost paid on the hot path by a
feature that is off by default.

`dispose()` detaches as well as releasing the ring, so a torn-down window stops
being sampled.
