[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [index](../README.md) / WorkerAgnostic

# Class: WorkerAgnostic

## Constructors

### Constructor

> **new WorkerAgnostic**(`workerSource`, `options?`): `WorkerAgnostic`

Create a `WorkerAgnostic` wrapping the underlying native worker for the
given source.

#### Parameters

##### workerSource

`string` \| `Function`

A Worker constructor, a worker
  factory function, or a path/URL string. When a function is provided it is
  invoked (or constructed with `new`) to obtain the underlying worker-like
  object. When a string is provided it is used to construct the appropriate
  native Worker for the current environment.

##### options?

Options forwarded to the native
  Worker constructor (e.g. `{ type: 'module' }` for Node, or worker options
  for the browser).

#### Returns

`WorkerAgnostic`

## Properties

### \_disposed

> **\_disposed**: `boolean`

***

### \_listeners

> **\_listeners**: `Map`\<`any`, `any`\>

***

### \_nativeModel

> **\_nativeModel**: `string` \| `undefined`

***

### \_wired

> **\_wired**: \[`string`, (...`args`) => `void`\][]

***

### \_wiredProperties

> **\_wiredProperties**: \[`string`, `any`\][]

***

### env

> **env**: `string`

***

### options

> **options**: `object`

***

### worker

> **worker**: `WorkerLike`

## Methods

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### addEventListener()

> **addEventListener**(`type`, `handler`): `WorkerAgnostic`

#### Parameters

##### type

`string`

##### handler

(`arg0`) => `void`

#### Returns

`WorkerAgnostic`

***

### dispose()

> **dispose**(): `void`

Release every resource this instance holds.

This wrapper owns the underlying worker and the native listeners it attached
to it, and both were previously unreleasable: the listeners were anonymous
arrow functions passed straight to `addEventListener`, so no handle existed to
remove them.

**It does not terminate the worker.** `WorkerAgnostic` wraps a worker handed
to it by a caller, and terminating it would be a decision this class has no
mandate to make — `PowerPool` owns the lifecycle of its workers and drives
termination itself. So this detaches everything it attached and drops its own
listener registry; it leaves the worker alone. A caller that does own the
worker should terminate it, which is what the owning helper is for.

Idempotent, and safe on an instance whose `_wireEvents` bailed early.

#### Returns

`void`

***

### off()

> **off**(`type`, `handler`): `WorkerAgnostic`

Node-style alias for [removeEventListener](#removeeventlistener).

#### Parameters

##### type

`string`

##### handler

(`arg0`) => `void`

#### Returns

`WorkerAgnostic`

***

### on()

> **on**(`type`, `handler`): `WorkerAgnostic`

Node-style alias for [addEventListener](#addeventlistener).

#### Parameters

##### type

`string`

##### handler

(`arg0`) => `void`

#### Returns

`WorkerAgnostic`

***

### postMessage()

> **postMessage**(`message`, `transfer?`): `any`

#### Parameters

##### message

`any`

##### transfer?

`Object` \| `ArrayBuffer`[] \| `ArrayBufferView`\<`ArrayBufferLike`\>[]

#### Returns

`any`

***

### removeEventListener()

> **removeEventListener**(`type`, `handler`): `WorkerAgnostic`

#### Parameters

##### type

`string`

##### handler

(`arg0`) => `void`

#### Returns

`WorkerAgnostic`

***

### terminate()

> **terminate**(): `void` \| `Promise`\<`void`\>

#### Returns

`void` \| `Promise`\<`void`\>

***

### create()

> `static` **create**(`workerSource`, `options?`): `object`

Transparently create the underlying native worker without wrapping it in a
`WorkerAgnostic` instance. Useful for callers (such as PowerPool) that wrap
the raw worker themselves but still want environment-agnostic creation.

#### Parameters

##### workerSource

`string` \| `Function`

##### options?

`Object`

#### Returns

`object`

The underlying worker-like object.
