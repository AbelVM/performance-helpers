import { parentPort } from 'worker_threads';
import { decodeMessage } from '../../src/helpers/powerMessageCodec.js';

// Reference example of a worker written against the 2.0 framed protocol
// (PowerPool's default). It also accepts a 1.x bare-JSON body so the same
// worker can interoperate with a pool still on `messageCodec: 'legacy'`.
function unwrap(data) {
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) return data;
  try {
    return decodeMessage(data).value;
  } catch {
    // 1.x peer: a bare Uint8Array of JSON.
    return JSON.parse(new TextDecoder().decode(data));
  }
}

// Echoes any message back to the parent, tagging it with `echo: true`.
parentPort.on('message', (msg) => {
  parentPort.postMessage({ echo: true, received: unwrap(msg) });
});
