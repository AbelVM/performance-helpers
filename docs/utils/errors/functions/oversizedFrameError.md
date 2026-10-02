[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/errors](../README.md) / oversizedFrameError

# Function: oversizedFrameError()

> **oversizedFrameError**(`className`, `size`, `limit`): `Error` & `object`

The error reported for a frame over `maxPayloadSizeBytes`.

Shared by the two socket helpers for the reason `queueFullError` above is
shared: one condition, one string, written once. The message states
**detection, not prevention**, because that is the honest description and a
limit that sounds like a limit and is not is worse than no limit at all — by
the time either helper can measure a frame the platform has already
materialised and buffered it, so the figure reports what arrived rather than
stopping it. The prevention belongs at the edge that owns the bytes.

The wording is asserted by a test rather than trusted to this comment: the
phrases "detection, not prevention", "already received and buffered" and
"Bound the payload at the peer that produces it" are each matched directly, so
a rewrite that softens them fails instead of quietly restoring a promise the
option cannot keep.

## Parameters

### className

`string`

The reporting helper, for a message that says where.

### size

`number`

The frame's length in bytes.

### limit

`number`

The configured limit it exceeded.

## Returns

`Error` & `object`

Error with a stable `code` and both figures, so a caller does not parse
  text — the same shape [queueFullError](queueFullError.md) returns.
