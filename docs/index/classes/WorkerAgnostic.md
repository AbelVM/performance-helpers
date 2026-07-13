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

`Object` = `{}`

Options forwarded to the native Worker
  constructor (e.g. `{ type: 'module' }` for Node, or worker options for
  the browser).

#### Returns

`WorkerAgnostic`

## Properties

### \_listeners

> **\_listeners**: `Map`\<`any`, `any`\>

***

### \_nativeModel

> **\_nativeModel**: `string` \| `undefined`

***

### env

> **env**: `string`

***

### options

> **options**: `Object`

***

### worker

> **worker**: `object`

## Methods

### addEventListener()

> **addEventListener**(`type`, `handler`): `WorkerAgnostic`

#### Parameters

##### type

`any`

##### handler

`any`

#### Returns

`WorkerAgnostic`

***

### off()

> **off**(`type`, `handler`): `WorkerAgnostic`

#### Parameters

##### type

`any`

##### handler

`any`

#### Returns

`WorkerAgnostic`

***

### on()

> **on**(`type`, `handler`): `WorkerAgnostic`

#### Parameters

##### type

`any`

##### handler

`any`

#### Returns

`WorkerAgnostic`

***

### postMessage()

> **postMessage**(`message`, `transfer`): `any`

#### Parameters

##### message

`any`

##### transfer

`any`

#### Returns

`any`

***

### removeEventListener()

> **removeEventListener**(`type`, `handler`): `WorkerAgnostic`

#### Parameters

##### type

`any`

##### handler

`any`

#### Returns

`WorkerAgnostic`

***

### terminate()

> **terminate**(): `any`

#### Returns

`any`

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
