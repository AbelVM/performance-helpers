[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/frameSize](../README.md) / frameByteLength

# Function: frameByteLength()

> **frameByteLength**(`data`): `number`

Length of one frame in bytes, across every shape these helpers receive.

**A string is counted in UTF-16 code units, not UTF-8 bytes.** That is a real
approximation and it is deliberate: the alternative is a `TextEncoder` per
frame on the hot path to get an exact figure for the payload shape this limit
is least useful on. `Buffer.byteLength` and `Blob.size` are exact, so binary
frames — the ones a limit exists for — are not approximated. If you need an
exact figure for text frames, size them at the peer that produces them.

## Parameters

### data

`any`

The frame, in whatever shape arrived.

## Returns

`number`

Bytes, or `0` when the shape carries no readable length.
