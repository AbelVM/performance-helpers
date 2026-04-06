[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PowerPoolOptions

# Interface: PowerPoolOptions

## Properties

### debugLevel?

> `optional` **debugLevel?**: `number`

Debug verbosity level for internal logging.

***

### idleTimeout?

> `optional` **idleTimeout?**: `number`

Milliseconds after which idle workers beyond `minSize` are terminated.

***

### lazy?

> `optional` **lazy?**: `boolean`

If true, defer creating workers up to `size` until demand; only `minSize` workers are created at construction.

***

### listenerMaxListeners?

> `optional` **listenerMaxListeners?**: `number`

***

### maxSize?

> `optional` **maxSize?**: `number`

Maximum number of workers allowed in the pool. Coerced to be at least `minSize`.

***

### maxTasksPerWorker?

> `optional` **maxTasksPerWorker?**: `number`

Soft capacity per worker used during task dispatch.

***

### minSize?

> `optional` **minSize?**: `number`

Minimum number of workers to keep alive.

***

### queueHighThreshold?

> `optional` **queueHighThreshold?**: `number`

Optional threshold; when `queue.length > queueHighThreshold` the pool emits a `pool:queue:high` event on the internal bus.

***

### queuePolicy?

> `optional` **queuePolicy?**: `"enqueue"` \| `"drop-oldest"` \| `"drop-newest"` \| `"reject"`

Queue overflow behavior when the pool is saturated.

***

### size?

> `optional` **size?**: `number`

Initial number of workers to create when `lazy` is false.

***

### taskQueue?

> `optional` **taskQueue?**: `boolean`

Whether to queue tasks when all workers are busy.

***

### weakListeners?

> `optional` **weakListeners?**: `boolean`

***

### workerOptions?

> `optional` **workerOptions?**: `Object`

Options forwarded to the underlying `Worker` constructor when using a string path.
