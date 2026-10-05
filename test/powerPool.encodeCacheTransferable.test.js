/**
 * GAP-011: the encode cache's shared buffers are marked, so the platform refuses to transfer them.
 *
 * `_encodeCache` hands the **same** `Uint8Array` to every caller encoding the same payload.
 * Transferring it would detach the shared buffer, and the next cache hit would return a
 * zero-length husk — the payload arrives at the worker empty, with nothing thrown anywhere.
 * That was guarded by a doc note plus a detached-buffer pre-check, and POOL-009 recorded the
 * caveat: the pre-check catches the *second* transfer, not the first, and the first is the
 * one that does the damage.
 *
 * `markAsUntransferable()` moves the failure to the call site that made the mistake, because
 * the platform enforces it.
 *
 * **These tests drive the real `structuredClone` transfer path.** An earlier probe of mine used
 * a plain object's `postMessage`, which does no clone at all — it neither threw nor detached,
 * so it "showed" the marker doing nothing. It proved only that the fake was a fake.
 *
 * Counters and shapes throughout: the assertions are about what the buffer *is* after each
 * operation, never about how long anything took.
 */
import { describe, it, expect } from 'vitest';
import { markUntransferable, canMarkUntransferable } from '../src/utils/transferable.js';
import { PowerPool } from '../src/helpers/powerPool.js';

describe('markUntransferable', () => {
  it('makes the buffer un-transferable rather than detached', () => {
    // The distinction the whole row rests on, and it is the reason a marker beats a check:
    // a **refused** transfer leaves the bytes intact, a **performed** one destroys them.
    const marked = new ArrayBuffer(8);
    const plain = new ArrayBuffer(8);
    new Uint8Array(marked).set([1, 2, 3, 4, 5, 6, 7, 8]);
    new Uint8Array(plain).set([1, 2, 3, 4, 5, 6, 7, 8]);

    expect(markUntransferable(marked)).toBe(true);
    expect(() => structuredClone({ marked }, { transfer: [marked] })).toThrow();
    expect(() => structuredClone({ plain }, { transfer: [plain] })).not.toThrow();

    // Refused: still 8 bytes, still the right contents.
    expect(marked.byteLength).toBe(8);
    expect(Array.from(new Uint8Array(marked))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Performed: the control, so the assertion above is not vacuous.
    expect(plain.byteLength, 'the platform detached it, as it must').toBe(0);
  });

  it('marks through a view, which is how the pool reaches it', () => {
    // `pool._encodeForTransfer()` returns a `Uint8Array`, and the call site marks
    // `view.buffer` — so the view's buffer is what has to become un-transferable.
    const view = new Uint8Array([1, 2, 3, 4]);
    expect(markUntransferable(view.buffer)).toBe(true);
    expect(() => structuredClone({ view }, { transfer: [view.buffer] })).toThrow();
    expect(view.byteLength, 'and the view still reads its bytes').toBe(4);
  });

  it('is idempotent, and never throws on anything', () => {
    // Every failure mode is silent **by design**: a browser has no such API, a
    // SharedArrayBuffer is not markable, and a second mark is a no-op. None of those
    // is a reason to fail a `postMessage`.
    const b = new ArrayBuffer(4);
    expect(markUntransferable(b)).toBe(true);
    expect(markUntransferable(b), 'marking twice is fine').toBe(true);

    expect(markUntransferable(null)).toBe(false);
    expect(markUntransferable(undefined)).toBe(false);
    expect(markUntransferable(42)).toBe(false);
    expect(markUntransferable('nope')).toBe(false);
    expect(markUntransferable(new SharedArrayBuffer(8)), 'SAB cannot be transferred anyway').toBe(
      false
    );
    // A detached buffer is not markable either, and must not throw.
    const detachable = new ArrayBuffer(4);
    structuredClone({}, { transfer: [detachable] });
    expect(detachable.byteLength).toBe(0);
    expect(() => markUntransferable(detachable)).not.toThrow();
  });

  it('reports availability, so the platform difference is documented not discovered', () => {
    // Node floor is >=22.12.0 so this is true here; in a browser it is false and the
    // pool falls back to the pre-check it always had.
    expect(canMarkUntransferable()).toBe(true);
  });
});

describe('PowerPool marks its encode-cache buffers', () => {
  // The worker fake and the pool shape are copied from
  // `test/powerPool.prepareBuffers.test.js`, which is where `_encodeForTransfer` and
  // `_encodeCache` are already exercised. My first version guessed `new PowerPool({size:1})`
  // and every test in this file failed with `workerSource must be a function or string` —
  // a guess, not a defect. `lazy: false` so the worker exists without a tick of waiting.
  function Silent() {
    this.onmessage = null;
    this.postMessage = () => {};
    this.terminate = () => {};
  }

  /**
   * A pool over a silent worker. `_encodeForTransfer` is pure encoding, so the cache is
   * exercised without a real worker, a thread, or a timing assumption.
   *
   * @param {Object} [options] - Extra `PowerPool` options.
   * @returns {any} The pool.
   */
  const pool = (options = {}) =>
    new PowerPool(Silent, { size: 1, minSize: 1, maxSize: 1, lazy: false, ...options });

  it('returns a buffer the platform refuses to transfer', () => {
    const p = pool();
    const frame = p._encodeForTransfer({ hello: 'world' });
    expect(frame).toBeInstanceOf(Uint8Array);

    // The invariant this row enforces, asserted through the platform rather than through
    // an internal flag: the bytes are shared, so a transfer would break every later hit.
    expect(() => structuredClone({ frame }, { transfer: [frame.buffer] })).toThrow();
    expect(frame.byteLength, 'refused, not performed').toBeGreaterThan(0);
  });

  it('a second cache hit still returns the full payload', () => {
    // **The behaviour the marker exists to protect.** Before it, a caller that
    // transferred the cached buffer got no error and the *next* hit was empty. The
    // marker refuses the transfer, so the hit is intact — which is the whole point.
    const p = pool();
    const first = p._encodeForTransfer({ hello: 'world' });
    expect(() => structuredClone({ first }, { transfer: [first.buffer] })).toThrow();

    const second = p._encodeForTransfer({ hello: 'world' });
    expect(second.byteLength).toBe(first.byteLength);
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(p._encodeCache.size, 'and it really was a cache hit').toBe(1);
  });

  it('two identical payloads share one buffer, so the invariant is load-bearing', () => {
    // If each call produced a fresh buffer there would be nothing to protect and the
    // marker would be pointless. This is what makes the row necessary rather than
    // merely tidy.
    const p = pool();
    const a = p._encodeForTransfer({ k: 1 });
    const b = p._encodeForTransfer({ k: 1 });
    expect(b.buffer, 'the same ArrayBuffer, not a copy').toBe(a.buffer);
  });

  it('does not mark the buffer it returns on the cache-bypass paths', () => {
    // The large-payload path returns `o2u8(obj)` directly and never caches, so there is
    // nothing shared to protect. Marking it anyway would refuse a transfer the caller
    // is entitled to make — a real regression in the other direction.
    const p = pool();
    const big = 'x'.repeat(200_000);
    const frame = p._encodeForTransfer({ big });
    expect(p._encodeCache.size, 'nothing cached, so nothing marked').toBe(0);
    // And so it transfers normally.
    expect(() => structuredClone({ frame }, { transfer: [frame.buffer] })).not.toThrow();
    expect(frame.buffer.byteLength).toBe(0);
  });
});
