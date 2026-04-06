[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / WorkerObj

# Interface: WorkerObj

## Properties

### \_startTimes?

> `optional` **\_startTimes?**: `number`[] \| [`PowerQueue`](../../powerQueue/classes/PowerQueue.md)

Queue of start timestamps for inflight tasks (ms).

***

### id

> **id**: `number`

Numeric id for the worker entry.

***

### lastActive

> **lastActive**: `number`

Timestamp (ms) of last activity on this worker.

***

### latencyEwma?

> `optional` **latencyEwma?**: `number` \| `null`

EWMA of historical task latency (ms).

***

### tasks

> **tasks**: `number`

Number of active tasks currently assigned.

***

### worker

> **worker**: `Worker`

The underlying Worker instance or worker-like object.
