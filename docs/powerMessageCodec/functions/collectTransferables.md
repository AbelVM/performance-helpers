[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / collectTransferables

# Function: collectTransferables()

> **collectTransferables**(`value`, `maxDepth?`): `ArrayBuffer`[]

Every `ArrayBuffer` reachable from a value, for a transfer list.

Depth-limited, and it walks object properties only. Both limits fail in the
safe direction: a buffer it cannot reach is copied by the platform rather
than transferred, which is slower and never wrong. Widening the walk is a
performance change to make deliberately, not a correctness fix.

## Parameters

### value

`any`

### maxDepth?

`number` = `8`

## Returns

`ArrayBuffer`[]

Unique buffers, in encounter order.
