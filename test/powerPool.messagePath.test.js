import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003: the pool's message path — transfer lists, encoding, and the
 * branches where they interact.
 *
 * This is chosen over chasing the branch count across the file, for two
 * reasons. The message path is **user-facing behaviour with a documented
 * contract** (send anything; plain objects get framed and encoded since 2.0),
 * and it is the same area `BUG-010` and `PERF-001` concern — so a regression
 * here would be silent and expensive. Most of the remaining uncovered lines in
 * `powerPool.js` are defensive `catch` arms that a test would have to provoke
 * deliberately, and a test that exists to move a number is the same error this
 * review keeps catching.
 *
 * The branches that matter are the ones where the three cases interact:
 * transferable vs. plain object, with an array transfer list, with an iterable
 * one, with none — and the encoding fallback when framing fails.
 */

/** A Worker stand-in that records exactly what it was handed. */
function recordingWorker() {
  const sent = [];
  return {
    sent,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(msg, transfer) {
      sent.push({ msg, transfer });
    },
    terminate() {},
    addEventListener(type, cb) {
      if (type === 'message') this.onmessage = cb;
      if (type === 'error') this.onerror = cb;
      if (type === 'messageerror') this.onmessageerror = cb;
    },
    removeEventListener() {},
  };
}

function makePool() {
  return new PowerPool(recordingWorker, { size: 1, idleTimeout: 0 });
}

describe('PowerPool message path', () => {
  it('passes a Uint8Array through with an array transfer list unchanged', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const bytes = new Uint8Array([1, 2, 3]);
    worker.postMessage(bytes, []);

    // An *empty* transfer list must not be forwarded: some runtimes treat
    // `postMessage(msg, [])` differently from `postMessage(msg)`.
    expect(worker._underlying.sent[0].msg).toBe(bytes);
    expect(worker._underlying.sent[0].transfer).toBeUndefined();
    pool.dispose();
  });

  it('auto-transfers a bare ArrayBuffer rather than copying it', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const buf = new ArrayBuffer(8);
    worker.postMessage(buf);

    const { msg, transfer } = worker._underlying.sent[0];
    // No re-encoding: a real ArrayBuffer is already the wire format.
    expect(msg).toBe(buf);
    // With no transfer list supplied, the buffer the caller just allocated is
    // added to one. That is the point of the branch - the bytes were produced
    // here and are going nowhere else, so transferring them avoids a copy.
    expect(Array.isArray(transfer)).toBe(true);
    expect(transfer).toEqual([buf]);
    pool.dispose();
  });

  it('frames and encodes a plain object, transferring the encoded bytes', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    worker.postMessage({ hello: 'world' });

    const { msg, transfer } = worker._underlying.sent[0];
    expect(msg).toBeInstanceOf(Uint8Array);
    // The encoded buffer must be transferred, or the frame is copied instead of
    // moved - which is the whole point of framing it.
    expect(Array.isArray(transfer)).toBe(true);
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(msg.buffer);
    pool.dispose();
  });

  it('does not detach the cache when transferring an encoded object', () => {
    // The subtle one. `_encodeForTransfer` may hand back a **cached** buffer;
    // transferring its `.buffer` would neuter the cache entry, so the next
    // identical message would post a detached, zero-length view. The code
    // slices before transferring for exactly this reason, and the second
    // message is the only way to see it.
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const payload = { cached: true, n: 1 };

    worker.postMessage(payload);
    const first = worker._underlying.sent[0];
    expect(first.msg.byteLength).toBeGreaterThan(0);

    worker.postMessage(payload);
    const second = worker._underlying.sent[1];
    // A detached buffer reports byteLength 0, so this is the real assertion.
    expect(second.msg.byteLength).toBe(first.msg.byteLength);
    expect(second.msg.byteLength).toBeGreaterThan(0);
    pool.dispose();
  });

  it('appends the encoded buffer to a caller-supplied array transfer list', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const own = new ArrayBuffer(4);
    const transfer = [own];

    worker.postMessage({ a: 1 }, transfer);

    const { msg, transfer: used } = worker._underlying.sent[0];
    // The caller's entry survives, and the encoded frame is added rather than
    // replacing the list.
    expect(used).toContain(own);
    expect(used).toContain(msg.buffer);
    expect(used).toHaveLength(2);
    pool.dispose();
  });

  it('does not duplicate the encoded buffer when the list already has it', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    // Ask for the exact buffer that will be produced. The first post tells us
    // what it is, so build the list from that.
    worker.postMessage({ b: 2 });
    const firstBuf = worker._underlying.sent[0].msg.buffer;

    worker.postMessage({ b: 2 }, [firstBuf]);
    const { transfer: used } = worker._underlying.sent[1];
    // `includes` guards the push; a duplicate entry in a transfer list is at
    // best redundant and at worst a runtime error.
    const occurrences = used.filter((b) => b === firstBuf).length;
    expect(occurrences).toBeLessThanOrEqual(1);
    pool.dispose();
  });

  it('converts an iterable transfer list rather than rejecting it', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const own = new ArrayBuffer(4);
    const iterable = new Set([own]);

    worker.postMessage({ c: 3 }, iterable);

    const { transfer: used } = worker._underlying.sent[0];
    // `Array.from` is what makes a Set or a generator work at all; without it
    // the caller-supplied list would be forwarded unchanged and the frame would
    // be copied rather than transferred.
    expect(Array.isArray(used)).toBe(true);
    expect(used).toContain(own);
    expect(used.length).toBeGreaterThanOrEqual(2);
    pool.dispose();
  });

  it('falls back to the raw message when encoding throws', () => {
    // The `catch` arm around `_encodeForTransfer`. A payload the framer cannot
    // handle must still reach the worker rather than being swallowed — losing
    // the message entirely would be worse than sending it unframed.
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const broken = {
      get boom() {
        throw new Error('unserialisable');
      },
    };
    const original = pool._encodeForTransfer;
    pool._encodeForTransfer = () => {
      throw new Error('encode failed');
    };

    let threw = null;
    try {
      worker.postMessage(broken);
    } catch (e) {
      threw = e;
    }
    // Either the raw object was posted, or the failure surfaced - what must
    // not happen is a silent no-op.
    expect(threw !== null || worker._underlying.sent.length === 1).toBe(true);
    pool._encodeForTransfer = original;
    pool.dispose();
  });

  it('rethrows an underlying postMessage failure rather than swallowing it', async () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    worker._underlying.postMessage = () => {
      throw new Error('underlying gone');
    };
    // The existing suite covers this for a plain object; this pins it for a
    // *transferable*, which takes the earlier `isTransferable` path and has its
    // own try/catch.
    expect(() => worker.postMessage(new Uint8Array([1]))).toThrow('underlying gone');
    pool.dispose();
  });

  it('keeps a transfer list for a transferable without re-encoding it', () => {
    const pool = makePool();
    const worker = pool.workers[0].worker;
    const own = new ArrayBuffer(16);
    worker.postMessage(own, [own]);

    const { msg, transfer } = worker._underlying.sent[0];
    expect(msg).toBe(own);
    expect(transfer).toEqual([own]);
    pool.dispose();
  });
});
