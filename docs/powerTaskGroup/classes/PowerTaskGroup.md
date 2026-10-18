[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerTaskGroup](../README.md) / PowerTaskGroup

# Class: PowerTaskGroup

## Constructors

### Constructor

> **new PowerTaskGroup**(`options?`): `PowerTaskGroup`

#### Parameters

##### options?

[`PowerTaskGroupOptions`](../interfaces/PowerTaskGroupOptions.md) = `{}`

#### Returns

`PowerTaskGroup`

## Properties

### \_cancelOnError

> **\_cancelOnError**: `boolean`

***

### \_controller

> **\_controller**: `AbortController`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_firstError

> **\_firstError**: `any`

***

### \_tasks

> **\_tasks**: `Set`\<`any`\>

## Accessors

### disposed

#### Get Signature

> **get** **disposed**(): `boolean`

Whether the scope has been disposed.

##### Returns

`boolean`

***

### signal

#### Get Signature

> **get** **signal**(): `AbortSignal`

The scope's abort signal, shared by every task.

##### Returns

`AbortSignal`

***

### size

#### Get Signature

> **get** **size**(): `number`

Number of tasks currently in flight.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Asynchronous disposal: aborts and awaits all tasks.

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

Synchronous disposal: aborts all tasks but does not await them.

#### Returns

`void`

***

### all()

> **all**(): `Promise`\<`any`[]\>

Wait for all in-flight tasks to settle.

#### Returns

`Promise`\<`any`[]\>

***

### cancel()

> **cancel**(): `Promise`\<`void`\>

Abort every in-flight task and wait for them to settle.

#### Returns

`Promise`\<`void`\>

***

### dispose()

> **dispose**(): `Promise`\<`void`\>

Dispose the scope: abort all tasks and wait for them to settle.

#### Returns

`Promise`\<`void`\>

***

### run()

> **run**(`fn`): `Promise`\<`any`\>

Run an async task inside the scope. The task receives the scope's
`AbortSignal` and may return a value. The returned promise resolves with
the task's result or rejects with its error (or an `AbortError` if the
scope was cancelled).

#### Parameters

##### fn

(`signal`) => `any`

#### Returns

`Promise`\<`any`\>

***

### spawn()

> **spawn**(`fn`): `Promise`\<`any`\>

Spawn a task without awaiting it. Returns the promise for callers that
want to observe it; errors are still routed through `cancelOnError`.

#### Parameters

##### fn

(`signal`) => `any`

#### Returns

`Promise`\<`any`\>
