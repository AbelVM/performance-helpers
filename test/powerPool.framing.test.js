import { describe, it, expect, afterEach } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';
import { decodeMessage, MESSAGE_PROTOCOL_VERSION } from '../src/helpers/powerMessageCodec.js';

/**
 * POOL-001: `prepareBuffers` and `postMessageBatch` did not speak the documented
 * framed protocol.
 *
 * The single-worker fast path in `postMessageBatch` posts `prepared.message`
 * directly, and `prepareBuffers` produced an **unframed** encoded body — so the
 * worker received raw JSON where it expected an envelope and read `{` (123) as a
 * protocol version. The error a user saw was
 * `unsupported protocol version 123 (expected 1)`, pointing nowhere near the
 * cause, for every batched request.
 *
 * **These assertions are on the wire bytes, not on a return value.** The whole
 * defect is that the bytes were wrong while everything the API returned looked
 * right — `results[i] === true` for every item. A test that asserted the result
 * array would have passed against the broken code, which is what
 * `test/powerPool.batchPaths.test.js` does for the batch contract.
 *
 * The fake worker records what it was sent, so this needs no real Worker thread
 * and no timing.
 */

/**
 * Records every `postMessage`, so the bytes on the wire can be asserted.
 *
 * The instance is held in a module-level `last` rather than reached for through
 * `pool.workers[0].worker`, which is not the same object — the first draft of
 * this file used that path, got `undefined`, and reported three failures that
 * looked like the pool misbehaving rather than like a broken assertion.
 */
let last = null;
function Recording() {
  this.onmessage = null;
  this.onerror = null;
  this.onmessageerror = null;
  this.posted = [];
  last = this;
  this.postMessage = (msg, transfer) => {
    this.posted.push(transfer ? { msg, transfer } : { msg });
  };
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}) {
  last = null;
  const pool = new PowerPool(Recording, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    // The conditions the fast path needs: one worker, and no per-worker task cap,
    // which is what makes `postMessageBatch` take the single-worker branch.
    maxTasksPerWorker: Infinity,
    ...options,
  });
  pools.push(pool);
  pool.worker = last;
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

/**
 * The bytes a worker actually received, for one recorded send.
 *
 * @param {{msg: *}} entry
 * @returns {Uint8Array}
 */
function bytesOf(entry) {
  const { msg } = entry;
  if (msg instanceof Uint8Array) return msg;
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (ArrayBuffer.isView(msg)) return new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
  throw new Error(`expected bytes, got ${typeof msg}: ${String(msg)}`);
}

describe('batched messages carry the framed envelope (POOL-001)', () => {
  it('frames every item of a single-worker batch', () => {
    const pool = makePool();
    const results = pool.postMessageBatch([{ a: 1 }, { b: 2 }, { c: 3 }]);

    // The result array is the batch contract, and it was already right — which is
    // precisely why it could not catch this.
    expect(results).toEqual([true, true, true]);

    expect(last.posted).toHaveLength(3);
    for (const [i, entry] of last.posted.entries()) {
      const bytes = bytesOf(entry);
      // The version byte is the first thing `decodeMessage` reads, and `{` is
      // 123. That single number is the user-visible symptom.
      expect(
        bytes[0],
        `item ${i} is not framed — first byte is "${String.fromCharCode(bytes[0])}"`
      ).toBe(MESSAGE_PROTOCOL_VERSION);
      // And the frame must decode, which is the property the pool promises.
      expect(() => decodeMessage(bytes, { codec: 'framed' })).not.toThrow();
    }
  });

  it('frames what prepareBuffers hands to postMessageBatch', () => {
    // The same defect by the other route: a caller pre-encodes with
    // `prepareBuffers` and posts the result, which is the documented use for it.
    const pool = makePool();
    const prepared = pool.prepareBuffers([{ hot: 'payload' }], { clone: true });
    const results = pool.postMessageBatch(prepared);
    expect(results).toEqual([true]);

    const bytes = bytesOf(last.posted[0]);
    expect(bytes[0]).toBe(MESSAGE_PROTOCOL_VERSION);
    // `decodeMessage` returns a descriptor — `{ version, codec, value, byteLength }` —
    // rather than the payload itself. The first draft of this line reached for
    // `.hot` and reported `undefined` against a *correct* frame.
    const decoded = decodeMessage(bytes, { codec: 'framed' });
    expect(decoded.version).toBe(MESSAGE_PROTOCOL_VERSION);
    expect(decoded.value.hot).toBe('payload');
  });

  it('a single postMessage frames identically to a batch of one', () => {
    // The invariant behind the row: the batch path is an optimisation, so it must
    // produce the same bytes as the path it replaces. Two workers, so this goes
    // through the non-fast branch, and the two are compared directly.
    const single = makePool();
    const batch = makePool();
    single.postMessage({ same: true });
    batch.postMessageBatch([{ same: true }]);

    const a = bytesOf(single.worker.posted[0]);
    const b = bytesOf(batch.worker.posted[0]);
    // The framing header is the protocol version, a flags byte and a length
    // prefix, so a full byte comparison would also pin the JSON body. Comparing
    // the whole buffer is the stronger assertion and the body is deterministic
    // for the same input, so it is the one worth making.
    expect(b).toEqual(a);
  });

  it('reports the failure the way a user would have seen it', () => {
    // What `123 (expected 1)` actually was, pinned so the number in the row's
    // note cannot drift into being unexplainable. `{` is 123.
    expect('{'.charCodeAt(0)).toBe(123);
    const raw = new TextEncoder().encode(JSON.stringify({ a: 1 }));
    expect(raw[0]).toBe(123);
    expect(() => decodeMessage(raw, { codec: 'framed' })).toThrow(
      /unsupported protocol version 123/
    );
  });
});
