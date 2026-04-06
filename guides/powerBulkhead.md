# PowerBulkhead

A partitioned executor that isolates noisy workloads into separate concurrency lanes.

Use `PowerBulkhead` when you need to protect critical work from a noisy producer or a hot key. Tasks routed to one partition will queue and run independently from tasks in other partitions.

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `partitions` | `number` | `4` | Number of isolated execution partitions. Work in different partitions does not compete for the same concurrency slots.
| `maxConcurrency` | `number` | `1` | Maximum concurrent tasks allowed per partition.
| `queueCapacity` | `number` | `100` | Maximum number of tasks that may wait in the queue across all partitions.
| `partitioner` | `Function` | `null` | Optional function `(key) => partitionIndex` used to route a task based on a custom key.

## API

- `run(task, options)` — Enqueue a task for execution. When the chosen partition has available concurrency, the task runs immediately; otherwise it waits in that partition's queue.
- `tryRun(task, options)` — Attempt immediate execution and return a `Promise` if the partition has capacity, or `null` if it would have to queue.
- `drain()` — Wait until all active and queued tasks complete.
- `partitions` — Number of configured partitions.
- `maxConcurrency` — Maximum concurrent tasks per partition.
- `queueCapacity` — Maximum queue size across all partitions.
- `active` — Number of tasks currently running.
- `pending` — Number of tasks currently queued.
- `isFull` — `true` when the helper has reached its global queue capacity.

## Example

```js
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';

const bulkhead = new PowerBulkhead({
  partitions: 3,
  maxConcurrency: 2,
  queueCapacity: 20,
});

async function submitWork(item, partitionKey) {
  return bulkhead.run(() => {
    // any work can be async
    return fetch(`/api/resource/${item.id}`).then((res) => res.json());
  }, { partitionKey });
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
- If `queueCapacity` is reached, `run()` rejects immediately with `PowerBulkhead queue is full`.
- Because partitions do not steal capacity from each other, a hot partition cannot block progress in other partitions.
