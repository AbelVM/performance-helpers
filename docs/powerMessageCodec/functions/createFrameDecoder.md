[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / createFrameDecoder

# Function: createFrameDecoder()

> **createFrameDecoder**(`options`): `object`

Create an incremental frame decoder over an arbitrary byte stream.

[decodeMessage](decodeMessage.md) reads **one whole frame** and throws on anything less,
so it cannot be pointed at a socket, a `ReadableStream` or a `node:stream`
chunk — and it does throw, with a `RangeError` that says nothing about the
fact that the frame was merely *incomplete* rather than corrupt. That is the
normal state of a stream roughly once per frame, so the error arrives at a
rate that trains the reader to swallow it.

A second, quieter failure sits behind it: feed `decodeMessage` a chunk
carrying two frames and it returns the first and stops, reporting a
`byteLength` smaller than the input. Nothing throws. The remaining bytes are
simply never looked at, and the loss is invisible at the call site.

```javascript
const decoder = createFrameDecoder({ maxFrameBytes: 1 << 20 });
for await (const chunk of stream) {
  for (const { value } of decoder.push(chunk)) handle(value);
}
const tail = decoder.flush();
if (tail.length) console.warn('stream ended mid-frame', tail.length, 'bytes short');
```

The object is transport-neutral and synchronous. It is not a
`ReadableStream` transformer and not a generator, because the one thing it
has to get right — never mistaking a half-written payload for a whole one —
is a property of *byte counts*, and wrapping it in a stream abstraction moves
that arithmetic somewhere nobody will read it.

## How it buffers

A read cursor and a write cursor over one growable buffer. The accumulated
bytes are **not** re-copied on every `push`: the copy happens when the buffer
has to grow, and the live remainder is compacted in place when it would
otherwise force a growth it does not need. Re-concatenating per `push` is
O(n²) in the chunk count; this is linear in the bytes.

That is a statement about asymptotics, deliberately **not** a speed claim.
Measured at the shape this was designed against — 500 frames of ~422 bytes
delivered in 157 chunks of 1400 — offset bookkeeping and a naive
re-concatenate per chunk are indistinguishable: 1.00x and 1.19x on two runs,
with a 55-60 % min/max spread against a 28 % noise floor on this machine. The
two only separate once a frame is big enough for the copy to matter (1.9x at
32 KB frames), because at 422 bytes the copy is L1-resident and free. See the
"Not a speedup" section of the guide.

## The ceiling is required

`maxFrameBytes` has no default and is not optional. A frame declares its own
payload length, so a peer that sends a 6-byte header and then nothing holds
this decoder's buffer open at whatever size it named — with no bound, no
counter and no error. A default would be the same defect as RT-009's: a limit
that sounds like one and is not. Pass `Infinity` to say so out loud; that
call is greppable, which a default is not.

The ceiling is checked **when the header arrives**, not when the frame
completes, so an oversized frame is refused before its payload is buffered
rather than after. It bounds one frame, so a chunk carrying many small frames
may still transiently exceed it.

## Parameters

### options

#### maxFrameBytes

`number`

Largest acceptable **total** framed
  length, header included. Required; `Infinity` opts out of the ceiling.

#### rawAsBytes?

`boolean`

Passed to
  [decodeMessage](decodeMessage.md) per frame. Note that with a stream the view is only
  valid until the next `push`, which is a stronger caveat than it is for a
  complete frame.

#### strict?

`boolean`

Passed to [decodeMessage](decodeMessage.md) per
  frame. An unknown protocol version throws from `push`.

## Returns

`object`

### \[dispose\]

> **\[dispose\]**: () => `void`

#### Returns

`void`

### dispose

> **dispose**: () => `void`

#### Returns

`void`

### flush

> **flush**: (`options?`) => `Uint8Array`

#### Parameters

##### options?

###### strict?

`boolean`

#### Returns

`Uint8Array`

### pendingBytes

> `readonly` **pendingBytes**: `number`

### push

> **push**: (`chunk`) => `object`[]

#### Parameters

##### chunk

`ArrayBuffer` \| `Uint8Array`\<`ArrayBufferLike`\> \| `DataView`\<`ArrayBufferLike`\>

#### Returns

`object`[]

### reset

> **reset**: () => `void`

#### Returns

`void`

## Throws

If `maxFrameBytes` is absent, not a whole number, or
  below [HEADER\_BYTES](../variables/HEADER_BYTES.md).

## Throws

From `push`, naming `maxFrameBytes`, when a frame
  declares a length over the ceiling. From `flush({ strict: true })`, when the
  stream ended mid-frame.
