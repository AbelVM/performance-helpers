# PowerBulkhead

A partitioned executor that isolates noisy workloads into separate concurrency lanes.

Use `PowerBulkhead` when you need to protect critical work from a noisy producer or a hot key. Tasks routed to one partition will queue and run independently from tasks in other partitions.

## Constructor

| option           |       type | default | description                                                                                                              |
| ---------------- | ---------: | ------: | ------------------------------------------------------------------------------------------------------------------------ |
| `partitions`     |   `number` |     `4` | Number of isolated execution partitions. Work in different partitions does not compete for the same concurrency slots.   |
| `maxConcurrency` |   `number` |     `1` | Maximum concurrent tasks allowed per partition.                                                                          |
| `queueCapacity`  |   `number` |   `100` | Maximum number of tasks that may wait **in one partition**. The bulkhead can hold `queueCapacity * partitions` in total. |
| `partitioner`    | `Function` |  `null` | Optional function `(key) => partitionIndex` used to route a task based on a custom key.                                  |

## Weighted tasks

**New in 2.0.** `maxConcurrency` counts slots; `run` and `tryRun` take an
optional `weight` so one task can reserve more than one slot of its partition.

```javascript
const bulkhead = new PowerBulkhead({ maxConcurrency: 10 });

await bulkhead.run(heavyJob, { partitionKey: 'tenant-7', weight: 5 });
// five of that partition's ten slots are held while `heavyJob` runs
```

- **`weight` must be a whole number `>= 1`**, as on
  [the gate](powerPermitGate.md#weighted-permits-weight). `0`, a negative, a
  fraction, `NaN` and `Infinity` are refused.
- **`weight > maxConcurrency` rejects with a `TypeError`.** That task can never
  run in any partition, so queueing it would be a hang — the partition's
  `queueCapacity` would eventually reject it, but only after filling a queue with
  work that was never going to happen.
- **Weight is per partition, not global.** A `weight: 5` task on a
  `maxConcurrency: 10` bulkhead consumes five slots in _its own_ partition and
  touches nothing in the other three, which is the whole point of partitioning.
- **`queueCapacity` still counts tasks, not slots.** A partition's queue is
  bounded the same way whether the waiting tasks weigh 1 or 5.
- Defaults to `1`, so `run(task, { partitionKey })` behaves exactly as before.

## API

- `run(task, options)` — Enqueue a task for execution. When the chosen partition has available concurrency, the task runs immediately; otherwise it waits in that partition's queue. `options.signal` aborts the _wait_: the promise rejects with an `AbortError` and the task never runs. A task that already holds a permit is not interrupted — cancelling the queueing is not cancelling the work. See [cancelling a wait](powerPermitGate.md#cancelling-a-wait).
- `tryRun(task, options)` — Attempt immediate execution and return a `Promise` if the partition has capacity, or `null` if it would have to queue.
- `drain()` — Wait until all active and queued tasks complete.
- `partitions` — Number of configured partitions.
- `maxConcurrency` — Maximum concurrent tasks per partition.
- `queueCapacity` — Maximum queue size **per partition**. It is the budget for one lane, not for the bulkhead: a noisy partition spends only its own, and a critical partition is not turned away by it. The total that can wait is `queueCapacity * partitions`.
- `active` — Number of tasks currently running.
- `pending` — Number of tasks currently queued, summed across all partitions.
- `isFull` — `true` when **every** partition is at its budget, so no task that would have to queue can be admitted anywhere. One busy partition is the normal state of an isolated bulkhead and does not make the bulkhead full.
- `reset(options?)` — Clear the partition tables and counters. The bulkhead stays usable, and — deliberately — keeps its [metrics](metrics.md) registration, because a reset is reversible and unregistering would make the series flap.
- `dispose(options?)` — `reset()` plus releasing the metrics registration. Terminal. `using bulkhead = new PowerBulkhead(...)` calls this on scope exit, so a `using` block does not leave a bulkhead being sampled forever.

## Example

```js
import { PowerBulkhead } from 'performance-helpers/powerBulkhead';

const bulkhead = new PowerBulkhead({
  partitions: 3,
  maxConcurrency: 2,
  queueCapacity: 20,
});

async function submitWork(item, partitionKey) {
  return bulkhead.run(
    () => {
      // any work can be async
      return fetch(`/api/resource/${item.id}`).then((res) => res.json());
    },
    { partitionKey }
  );
}

const results = await Promise.all([
  submitWork({ id: 1 }, 'critical'),
  submitWork({ id: 2 }, 'critical'),
  submitWork({ id: 3 }, 'background'),
]);

await bulkhead.drain();
console.log('all work finished');
```

## Notes

- `PowerBulkhead` uses an internal `PowerQueue` for each partition to keep queued tasks O(1) on enqueue/dequeue.
- Tasks with the same `partitionKey` are routed to the same partition by default, so noisy or bursty keys can be isolated from healthier lanes.
- If that partition's `queueCapacity` is reached, `run()` rejects immediately with `PowerBulkhead queue is full`. The partition's own budget, not the bulkhead's total — a shared budget is not isolation.
- Because partitions do not steal capacity from each other, a hot partition cannot block progress in other partitions.

## Validation

`partitions`, `maxConcurrency` and `queueCapacity` are validated at
construction. Before 2.0 each was coerced into a plausible-looking number, and
**they were not wrong in the same direction**:

| Option              | Before                    | Was actually                                       | Now             |
| ------------------- | ------------------------- | -------------------------------------------------- | --------------- |
| `partitions: 0`     | `Math.max(1, 0 \|\| 4)`   | **4** — a caller asking for one partition got four | throws          |
| `maxConcurrency: 0` | `Math.max(1, 0 \|\| 1)`   | **1** — the opposite of the stated intent          | throws          |
| `queueCapacity: 0`  | `Math.max(0, 0 \|\| 100)` | **100** — "no queue" became the largest queue      | honoured as `0` |

`maxConcurrency: 0` is the same mistake `PowerPermitGate.capacity` stopped
making: a bulkhead configured to allow nothing is how you switch a dependency
off, and it silently admitted one task.

`queueCapacity: 0` is the more surprising one, because it is the _opposite_
error. `PowerPermitGate` documents `queueCapacity: 0` as a legal request — "refuse
immediately instead of queueing" — and this quietly turned that request into the
full default queue. A value that reads as "no queue" and produces the largest
queue the class supports is a contradiction, not a coercion. **`0` is honoured.**
