# Buffer helpers

Lightweight helpers for encoding/decoding JSON to/from binary (Uint8Array / ArrayBuffer / Node Buffer).

`powerBuffer` provides tiny, allocation-friendly helpers optimized for passing JSON payloads through transferable binary buffers (for example, when posting messages to Workers). It prefers zero-copy views for ArrayBuffer/TypedArray inputs and falls back to `TextEncoder`/`TextDecoder` (or Node `Buffer`) when available.

## o2u8(obj)

Encode a value to a `Uint8Array` (UTF-8 JSON).

- `obj` — Any value to encode. If the value is already a `Uint8Array`/TypedArray/ArrayBuffer it will be returned or converted to a view.

Returns: `Uint8Array` — UTF-8 encoded bytes. Throws if no encoder is available in the environment.

Example
```javascript
import { o2u8, u82o } from '../src/helpers/powerBuffer.js';

// encode a JSON payload to transferable Uint8Array and post to a worker
const payload = { id: 42, name: 'big-image', meta: { size: 1024 * 1024 } };
const bytes = o2u8(payload);
// `bytes.buffer` can be transferred to a Worker to avoid structured-clone copies
worker.postMessage(bytes, [bytes.buffer]);
```

## u82o(buf)

Decode a binary buffer (Uint8Array/ArrayBuffer/Buffer) containing JSON UTF-8 to a JS value.

- `buf` — The binary input to decode. Accepted types: `Uint8Array`, `ArrayBuffer`, TypedArray, or Node `Buffer`.

Returns: parsed JS value. Throws `TypeError` for unsupported input types or malformed UTF-8 JSON.

Example — worker receiver

```javascript
import { u82o } from '../src/helpers/powerBuffer.js';

self.onmessage = (e) => {
    // decode transferable Uint8Array back to JS value
    const obj = u82o(e.data);
    // process obj
};
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
    const output = o2u8(json_output);
    self.postMessage(output, [output.buffer])
})
```

```javascript
// worker.js
self.onmessage = (e) => {
    const jsonInput = u82o(e.data);
    const result = process(jsonInput);
    const out = o2u8(result);
    self.postMessage(out, [out.buffer]);
};

// main thread
worker.onmessage = (e) => {
    const jsonOut = u82o(e.data);
    handleResult(jsonOut);
};
```
