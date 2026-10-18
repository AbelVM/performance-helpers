[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / PowerBufferPool

# Class: PowerBufferPool

A pool of reusable `Uint8Array` buffers, keyed by size bucket.

## Why

Hot encode/decode paths (`o2u8`, message codecs, frame builders) allocate a
fresh `Uint8Array` per call. For a steady-state workload the sizes are
predictable, so the allocations are pure churn: the GC collects them a moment
later and the allocator hands out the same memory again. A pool keeps the
buffers alive and hands them back out, removing the allocation from the hot
path entirely.

## Contract

- `acquire(size)` returns a `Uint8Array` whose `byteLength` is at least
  `size`. It may be a pooled buffer (reused) or a freshly allocated one.
  The caller **owns** the returned buffer until it calls `release()`.
- `release(buf)` returns a buffer to the pool. Buffers whose size does not
  match a configured bucket, or that arrive when the pool is full, are
  dropped (the caller's reference is the only one left, so it is collected).
- A buffer handed out by `acquire()` must not be used after `release()`: the
  pool may hand the same memory to another caller. This is the documented
  footgun of every buffer pool; the saving has to be worth it.

 PowerBufferPool

## Constructors

### Constructor

> **new PowerBufferPool**(`options?`): `PowerBufferPool`

#### Parameters

##### options?

###### buckets?

`number`[]

Size
  buckets. A request is served from the smallest bucket that fits; a
  request larger than every bucket is allocated fresh and never pooled.

###### maxPerBucket?

`number`

Maximum buffers retained per
  bucket.

###### maxTotal?

`number`

Maximum buffers retained across all
  buckets.

#### Returns

`PowerBufferPool`

## Properties

### \_acquires

> **\_acquires**: `number`

***

### \_buckets

> **\_buckets**: `number`[]

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_drops

> **\_drops**: `number`

***

### \_maxPerBucket

> **\_maxPerBucket**: `number`

***

### \_maxTotal

> **\_maxTotal**: `number`

***

### \_pools

> **\_pools**: `Map`\<`number`, `Uint8Array`\<`ArrayBufferLike`\>[]\>

***

### \_releases

> **\_releases**: `number`

***

### \_reuses

> **\_reuses**: `number`

***

### \_total

> **\_total**: `number`

## Accessors

### buckets

#### Get Signature

> **get** **buckets**(): `number`[]

##### Returns

`number`[]

The configured buckets, ascending.

***

### pooled

#### Get Signature

> **get** **pooled**(): `number`

##### Returns

`number`

Buffers currently retained.

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### acquire()

> **acquire**(`size?`): `Uint8Array`\<`ArrayBufferLike`\>

Acquire a buffer of at least `size` bytes.

#### Parameters

##### size?

`number` = `0`

#### Returns

`Uint8Array`\<`ArrayBufferLike`\>

***

### dispose()

> **dispose**(): `void`

Release all retained buffers.

#### Returns

`void`

***

### release()

> **release**(`buf`): `boolean`

Return a buffer to the pool. Returns `true` when retained, `false` when
dropped (wrong size, pool full, or disposed).

#### Parameters

##### buf

`Uint8Array`\<`ArrayBufferLike`\>

#### Returns

`boolean`

***

### stats()

> **stats**(): `object`

Point-in-time statistics.

#### Returns

`object`

##### acquires

> **acquires**: `number`

##### buckets

> **buckets**: `number`[]

##### drops

> **drops**: `number`

##### maxPerBucket

> **maxPerBucket**: `number`

##### maxTotal

> **maxTotal**: `number`

##### pooled

> **pooled**: `number`

##### releases

> **releases**: `number`

##### reuseRate

> **reuseRate**: `number`

##### reuses

> **reuses**: `number`
