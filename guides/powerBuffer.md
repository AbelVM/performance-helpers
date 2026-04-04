# Buffer helpers

Lightweight helpers for encoding/decoding JSON to/from binary (Uint8Array / ArrayBuffer / Node Buffer).

`powerBuffer` provides tiny, allocation-friendly helpers optimized for passing JSON payloads through transferable binary buffers (for example, when posting messages to Workers). It prefers zero-copy views for ArrayBuffer/TypedArray inputs and falls back to `TextEncoder`/`TextDecoder` (or Node `Buffer`) when available.

## o2u8(obj)

Encode a value to a `Uint8Array` (UTF-8 JSON).

| name | type | default | description |
|---|---:|---:|---|
| `obj` | * | — | Any value to encode. If already a `Uint8Array`/TypedArray/ArrayBuffer it will be returned or converted to a view. |

Returns: `Uint8Array` — UTF-8 encoded bytes. Throws if no encoder available.

Example
```javascript
const payload = { hello: 'world' }
const bytes = o2u8(payload)
// bytes.buffer can be transferred to a Worker
```

## u82o(buf)

Decode a binary buffer (Uint8Array/ArrayBuffer/Buffer) containing JSON UTF-8 to a JS value.

| name | type | default | description |
|---|---:|---:|---|
| `buf` | `Uint8Array \| ArrayBuffer \| TypedArray \| Buffer` | — | Binary input containing JSON UTF-8. |

Returns: `*` — parsed JS value. Throws `TypeError` for unsupported input types.

Example

```javascript
const obj = u82o(bytes)
```

## o2b(obj)

Encode to an `ArrayBuffer` (legacy API). Returns an owning ArrayBuffer (slice if necessary).

Parameters: same as `o2u8`.

Returns: `ArrayBuffer`.

## b2o(buf)

Legacy wrapper around `u82o` for ArrayBuffer/TypedArray/Buffer.

## Recommendations

- Use `o2u8`/`u82o` when sending/receiving structured JSON through `postMessage` to make use of transferables and reduce copy overhead.

```javascript
// worker.js
self.onmessage(e => {
    const json_input = u82o(e.data);
    ...
    const output = o28u(json_output);
    self.postMessage(output, [output])
})
```

```javascript
// main.js
worker.onmessage(e => {
    const json_input = u82o(e.data);
    ...
})

const output = o28u(json_output);
worker.postMessage(output, [output])

```

- If you're already working with ArrayBuffer views, these helpers prefer zero-copy views to avoid allocations.
- Do not use these helpers for non-JSON binary protocols — they are JSON-centric.
