[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / encodeNativeEnvelope

# Function: encodeNativeEnvelope()

> **encodeNativeEnvelope**(`value`, `options?`): `object`

Wrap a value for the native structured-clone carrier.

Unlike [encodeNative](encodeNative.md) this does **not** clone: the transport clones
whatever it is handed, so cloning here would be a second deep copy for no
benefit. That is why it also computes no transfer list — a transfer list has
to name buffers inside the object being posted, and the only safe way to
post a caller's buffer without detaching it is to post a private copy. A
caller that needs the copy pays for it with [encodeNative](encodeNative.md); the common
case, a message with no binary in it, pays nothing.

## Parameters

### value

`any`

### options?

#### correlationId?

`string`

Echoed in replies. Top-level, not
nested, because that is where the pool looks when settling a response.

## Returns

`object`

### \_\_pp

> **\_\_pp**: `1`

### correlationId?

> `optional` **correlationId?**: `string`

### kind

> **kind**: `"envelope"`

### value

> **value**: `any`
