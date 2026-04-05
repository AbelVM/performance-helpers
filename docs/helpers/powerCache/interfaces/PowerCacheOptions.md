[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCache](../README.md) / PowerCacheOptions

# Interface: PowerCacheOptions

## Properties

### defaultTTL?

> `optional` **defaultTTL?**: `number`

***

### initialPoolSize?

> `optional` **initialPoolSize?**: `number`

***

### maxCleanupPerTick?

> `optional` **maxCleanupPerTick?**: `number`

***

### maxEntries?

> `optional` **maxEntries?**: `number`

***

### maxPoolSize?

> `optional` **maxPoolSize?**: `number`

***

### maxWeight?

> `optional` **maxWeight?**: `number`

***

### onEvict?

> `optional` **onEvict?**: (`arg0`, `arg1`, `arg2`) => `void`

#### Parameters

##### arg0

`any`

##### arg1

`any`

##### arg2

`string`

#### Returns

`void`

***

### onExpire?

> `optional` **onExpire?**: (`arg0`, `arg1`) => `void`

#### Parameters

##### arg0

`any`

##### arg1

`any`

#### Returns

`void`

***

### rejectOversized?

> `optional` **rejectOversized?**: `boolean`

***

### weightFn?

> `optional` **weightFn?**: (`arg0`) => `number`

#### Parameters

##### arg0

`any`

#### Returns

`number`
