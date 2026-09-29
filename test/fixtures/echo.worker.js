import { parentPort } from 'worker_threads';
import { decodeInbound } from '../../src/helpers/powerMessageCodec.js';

// Reference example of a worker written against the 2.0 framed protocol
// (PowerPool's default), readable on any `messageCodec`.
//
// `decodeInbound` reads all three carriers — a framed message, a native
// envelope, and a 1.x bare-JSON body — so this one worker interoperates with a
// pool on any mode, and with a pool mid-rollout. It replaces the
// try-the-frame-and-fall-back-to-bare-JSON dance that every worker otherwise
// re-derives, slightly differently each time.
//
// It deliberately does *not* advertise the native carrier. This fixture stands
// in for any worker, including ones that have never heard of negotiation, and
// `test/powerPool.negotiation.test.js` needs a worker that does not. A worker
// that wants the native carrier adds one line at start-up:
//
//     parentPort.postMessage(announceCapabilities());
//
// which `messageCodec: 'negotiated'` picks up from the next message on. The
// pool never asks: a pool-asks handshake would put a control message on a
// worker's port, which an un-migrated worker would run as a task. Asking only
// that a peer stay quiet is the one kind of negotiation that cannot break a
// peer that has never heard of it.
parentPort.on('message', (msg) => {
  const { value } = decodeInbound(msg);
  parentPort.postMessage({ echo: true, received: value });
});
