[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerScheduler](../README.md) / PowerScheduler

# Class: PowerScheduler

Small scheduler helper for coalescing work into a single microtask or macrotask.

This is useful for helpers that need to batch or debounce notifications while
preserving a flush API and a simple scheduling mode.

## Constructors

### Constructor

> **new PowerScheduler**(`flushFn`, `options?`): `PowerScheduler`

#### Parameters

##### flushFn

`Function`

Function called when the scheduled work is flushed.

##### options?

###### scheduling?

`"microtask"` \| `"macrotask"`

#### Returns

`PowerScheduler`

## Properties

### \_flushFn

> **\_flushFn**: `Function`

***

### \_scheduled

> **\_scheduled**: `boolean`

***

### \_scheduling

> **\_scheduling**: `string`

***

### \_timer

> **\_timer**: `number` \| `null`

## Accessors

### scheduled

#### Get Signature

> **get** **scheduled**(): `boolean`

Whether a flush is currently scheduled.

##### Returns

`boolean`

## Methods

### \_run()

> **\_run**(): `void`

#### Returns

`void`

***

### cancel()

> **cancel**(): `void`

Cancel any scheduled flush without invoking the callback.

#### Returns

`void`

***

### flush()

> **flush**(): `void`

Flush immediately if a callback is scheduled.

#### Returns

`void`

***

### schedule()

> **schedule**(): `void`

Schedule the flush callback once.

#### Returns

`void`
