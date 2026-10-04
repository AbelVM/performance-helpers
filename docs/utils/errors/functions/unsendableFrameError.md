[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/errors](../README.md) / unsendableFrameError

# Function: unsendableFrameError()

> **unsendableFrameError**(`className`, `size`, `limit`): `Error` & `object`

The error for an **outbound** frame the transport can never carry.

## Why this is not [oversizedFrameError](oversizedFrameError.md)

That factory's sentence — *"detection, not prevention — the frame was already
received and buffered before this was checked"* — is true of an **inbound**
frame and **false** here. `PowerRTCChannel` measures before it calls
`send()`, so the platform never saw the frame at all: this is prevention, and
reusing the other message would have told a caller debugging a refused send
that their oversized frame had already been put on the wire.

The condition also earns its own message because it is a different failure.
An over-size inbound frame is a peer bug worth alerting on. An over-size
outbound one is a local payload the caller should have bounded at the edge,
and the remedy is the same sentence for a different reason — bound it at the
peer that produces it.

The `code` is deliberately the **same** `'ERR_FRAME_TOO_LARGE'`, so one
`onError` handler filters the same way across all three helpers. The direction
is what differs, and it is stated in the text rather than encoded, because a
second code would split that one handler in two for no operational gain.

A test pins both messages against being merged into one factory; that is the
only thing standing between this and a shared-helper refactor that silently
turns a prevention into a report.

## Parameters

### className

`string`

The reporting helper, for a message that says where.

### size

`number`

The frame's length in bytes.

### limit

`number`

The ceiling it exceeded — the negotiated SCTP message
  size for a data channel.

## Returns

`Error` & `object`

The same shape [oversizedFrameError](oversizedFrameError.md) returns, so a caller does not
  branch on which helper produced it.
