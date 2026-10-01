[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/errors](../README.md) / queueFullError

# Function: queueFullError()

> **queueFullError**(`className`, `queueCapacity`): `Error` & `object`

The rejection a queue-bound helper produces when it refuses to queue.

## Why this exists

`PowerPermitGate` and `PowerBulkhead` both rejected a full queue with a bare
`new Error('… queue is full')`, so `err.code` was `undefined` and the only way
to distinguish the condition was to match on message text. Meanwhile the pool
had published `ERR_POOL_QUEUE_FULL` for the identical situation, and
`guides/errors.md` argues at length that the difference between *shedding load*
and *failing* is exactly what a code is for — retrying a refused call is what
filled the queue.

Three classes, one documented code, two unlabelled, is a shape a caller has to
remember rather than branch on. This gives the two queue-bound helpers the same
code as the pool, from one definition, so the string is written once.

Deliberately the **pool's** code rather than a new one: the condition is the
same (no capacity to accept, shed the load) and a caller handling
`ERR_POOL_QUEUE_FULL` already has the right response. Inventing
`ERR_QUEUE_FULL` would have made them branch in three places instead of one.

## Parameters

### className

`string`

The helper refusing, for the message.

### queueCapacity

`number`

The configured bound that was reached.

## Returns

`Error` & `object`

Error with
  a stable `code` and the bound that was hit, so a caller does not parse text.
