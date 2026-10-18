[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerDatagramChannel](../README.md) / PowerDatagramChannelOptions

# Interface: PowerDatagramChannelOptions

## Properties

### fragment?

> `optional` **fragment?**: `boolean`

Enable fragmentation with the default
  fragment size.

***

### fragmentSize?

> `optional` **fragmentSize?**: `number`

Fragment size for large datagrams. `0`
  disables fragmentation. Defaults to `1024` when `fragment` is true.

***

### maxDatagramSizeBytes?

> `optional` **maxDatagramSizeBytes?**: `number`

Hard ceiling on outbound
  datagram size. A datagram larger than this is refused with a `TypeError`
  before it reaches the transport. `0` disables the check.

***

### maxQueue?

> `optional` **maxQueue?**: `number`

Maximum datagrams buffered for sending
  when the transport is not ready. `0` disables queueing: a datagram arriving
  while the transport is closed is refused immediately.

***

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../helpers/metrics/classes/MetricsCollector.md)

Opt in to metrics. See `guides/metrics.md`.

***

### onError?

> `optional` **onError?**: (`arg0`, `arg1`) => `void`

Called when the
  underlying transport throws or when an oversize datagram is refused.

#### Parameters

##### arg0

`Error`

##### arg1

`object`

#### Returns

`void`
