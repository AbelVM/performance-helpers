[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PowerPoolShutdownError

# Class: PowerPoolShutdownError

PowerPoolShutdownError

Error thrown when the `PowerPool` is shut down and pending tasks are rejected.

Carries `code === 'ERR_POOL_TERMINATED'`, the same code the pool uses for the
synchronous throw from a dispatch method on a shut-down pool. Both mean the
same thing — the pool is finished, so is the work — and `guides/errors.md`
tells callers to branch on `err.code`. Without it, a caller awaiting a
response at shutdown got an error with no code and fell through the
documented `switch` to `default`, which is the case most likely to be hit:
shutting down is exactly when pending promises are still outstanding.
`name` is unchanged, so `err.name === 'PowerPoolShutdownError'` keeps
working.

PowerPoolShutdownError

## Extends

- `Error`

## Constructors

### Constructor

> **new PowerPoolShutdownError**(`message?`): `PowerPoolShutdownError`

#### Parameters

##### message?

`string` = `'PowerPool has been shut down'`

#### Returns

`PowerPoolShutdownError`

#### Overrides

`Error.constructor`

## Properties

### cause?

> `optional` **cause?**: `unknown`

#### Inherited from

`Error.cause`

---

### code

> **code**: `string`

---

### message

> **message**: `string`

#### Inherited from

`Error.message`

---

### name

> **name**: `string`

#### Inherited from

`Error.name`

---

### stack?

> `optional` **stack?**: `string`

#### Inherited from

`Error.stack`
