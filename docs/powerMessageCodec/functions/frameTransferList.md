[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / frameTransferList

# Function: frameTransferList()

> **frameTransferList**(`frame`): `ArrayBuffer`[]

The transfer list for a framed `Uint8Array`. Note that transferring detaches
the frame's `buffer`, so the frame must not be reused afterwards.

Two inputs cannot be answered by handing back `frame.buffer`, and both were
**wrong answers rather than slow ones** (RT-022):

- A **SAB-backed** frame. A `SharedArrayBuffer` is not transferable, so naming
  one here makes `postMessage` throw `DOMException: Found invalid value in
  transferList` \u2014 measured \u2014 rather than post. It must also not be detached, so the
  only correct answer is to leave it out and let the frame be copied.
- A **view into a slab**. `frame.buffer` names the whole buffer, so a 6-byte
  view into a 16-byte slab transferred all 16 and left the caller with a
  detached slab \u2014 measured, `slab.byteLength === 0` afterwards \u2014 silently
  destroying bytes that had nothing to do with this frame. There is no
  transfer list that expresses "these six bytes", so this is rejected instead.

## Parameters

### frame

`Uint8Array`\<`ArrayBufferLike`\>

## Returns

`ArrayBuffer`[]

## Throws

When `frame` is a view into part of a larger buffer.
