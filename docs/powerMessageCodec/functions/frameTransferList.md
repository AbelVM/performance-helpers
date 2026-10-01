[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / frameTransferList

# Function: frameTransferList()

> **frameTransferList**(`frame`): `ArrayBuffer`[]

The transfer list for a framed `Uint8Array`. Note that transferring detaches
the frame's `buffer`, so the frame must not be reused afterwards.

## Parameters

### frame

`Uint8Array`\<`ArrayBufferLike`\>

## Returns

`ArrayBuffer`[]
