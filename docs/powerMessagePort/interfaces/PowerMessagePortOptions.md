[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessagePort](../README.md) / PowerMessagePortOptions

# Interface: PowerMessagePortOptions

## Properties

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to metrics. See `guides/metrics.md`.

***

### onClose?

> `optional` **onClose?**: () => `void`

Called when the port closes.

#### Returns

`void`

***

### onError?

> `optional` **onError?**: (`arg0`) => `void`

Called when an inbound message
  cannot be decoded.

#### Parameters

##### arg0

`Error`

#### Returns

`void`

***

### onMessage?

> `optional` **onMessage?**: (`arg0`, `arg1`) => `void`

Called with
  the decoded `value` and optional `correlationId` for each inbound message.

#### Parameters

##### arg0

`any`

##### arg1

`string` \| `undefined`

#### Returns

`void`
