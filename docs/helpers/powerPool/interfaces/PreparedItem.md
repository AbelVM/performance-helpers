[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerPool](../README.md) / PreparedItem

# Interface: PreparedItem

## Properties

### deferred?

> `optional` **deferred?**: `boolean`

Framing is still owed; see above.

***

### message

> **message**: `any`

The value to post. A `Uint8Array` under a framing codec,
  the original object when `deferred`.

***

### transfer

> **transfer**: `TransferList` \| `undefined`

Must be `undefined` whenever
  `message` is a shared buffer: a transfer list detaches its entries, and a
  detached cache entry is the bug `clone` exists to avoid.
