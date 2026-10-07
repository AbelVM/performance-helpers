[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBroadcastBus](../README.md) / PowerBroadcastBusOptions

# Interface: PowerBroadcastBusOptions

## Properties

### ackTimeoutMs?

> `optional` **ackTimeoutMs?**: `number`

Timeout in milliseconds for acks.

***

### channel

> **channel**: `BroadcastChannel`

The BroadcastChannel to use.

***

### onSlowConsumer?

> `optional` **onSlowConsumer?**: (`receiverId`) => `void`

Called when a
  receiver is marked as slow. The hub passes a callback that sets
  `sub.slowConsumer = true`; the bus itself never touches subscriber records.

#### Parameters

##### receiverId

`string`

#### Returns

`void`
