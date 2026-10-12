---
'performance-helpers': patch
---

### Added

`PowerPool`'s `loadBalancer` option — a caller-supplied worker-selection policy.

```js
const pool = new PowerPool(WorkerScript, {
  loadBalancer: (workers) => {
    // `workers` is a frozen array of { id, tasks, latencyEwma, lastActive }
    const quietest = workers.reduce((a, b) => (b.tasks < a.tasks ? b : a));
    return quietest.id; // or the object itself
  },
});
```

**The default policy is not replaced.** PowerPool's least-loaded-plus-EWMA rule beats
Piscina's for heterogeneous tasks, so this adds a choice rather than taking one away.
Omitting `loadBalancer` behaves exactly as before, and that equivalence is pinned by a
test so a future change cannot quietly alter it.

**The view a balancer receives is a plain frozen object, not the live `WorkerObj`.** This
is the security-shaped half of the change. A caller-supplied balancer is caller code
running _inside_ the pool, invoked from the pool's own send path — so handing it the live
object would hand it `worker.terminate()`, the `WorkerAgnostic`, and everything reachable
from them: enough to break the pool from a callback the pool itself calls. A frozen
snapshot of four fields cannot do any of that, and `Object.freeze` makes the attempt loud
rather than silent.

`latencyEwma` is in the view explicitly rather than left for a balancer to reach past it
for, because the whole point of the view is that reaching past it is not possible.

A balancer that throws, or returns nothing usable — `null`, `undefined`, an id not in the
pool — **falls back to the default rule** rather than breaking the send path. The
alternative turns a caller's bug into every other caller's outage. A non-function
`loadBalancer` is rejected once at construction instead of silently ignored on every
dispatch.

The same frozen view is reported per worker by `getStats().workers`, so an operator
debugging a custom policy reads exactly what the policy read.

### Tests

11 tests in `test/powerPool.loadBalancer.test.js`, mutation-checked 6 of 6 — including
reverting the view to the live `WorkerObj`, which is the security hole itself.

The frozen-view tests were written **before** the implementation, which is the order the
change needed: the constraint is the part most likely to be got wrong, and writing the
test first means the implementation cannot accidentally hand out the live object. They
assert on the constructor and on frozenness rather than on field values, because a live
`WorkerObj` is neither plain nor frozen and carries `terminate()` — and one test mutates
the view and asserts the pool's own accounting is untouched, which is the consequence
rather than the mechanism.
