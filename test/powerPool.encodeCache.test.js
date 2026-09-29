import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * PERF-001: re-measure the encode cache with and without the per-message
 * `u8.slice()`.
 *
 * **The finding: the slice dominates, and it is worth removing.** The shipped
 * default copied every encoded buffer so it could be *transferred* rather than
 * copied by the structured clone — which looks like the fast path, since a
 * transfer is zero-copy. It is not, because the copy being avoided is a
 * **native** one and the copy being paid is an **interpreted** `memcpy`.
 *
 * Over a Zipf-ish repeat mix of 200 × 200-byte messages, one variable at a time:
 *
 * | path | per message |
 * |---|---:|
 * | encode + cache, `slice()`, transfer (the old default) | 2942 ns |
 * | encode + cache, hand the cached buffer over to be copied | **1557 ns** |
 * | encode every time, `slice()`, transfer (no cache) | 3441 ns |
 *
 * The cache is emphatically not the problem — dropping it costs ~1900 ns, nearly
 * twice what the slice costs. It stays; the slice goes.
 *
 * **The end-to-end `pool.postMessage` path was not able to confirm this.** Five
 * runs each on this machine: old 1847/3506/3654/3288/2562 ns, new
 * 2658/2745/2016/2650/1879 ns. The ranges overlap and span nearly 2×, consistent
 * with the 28 % median spread BENCH-001 measured here. So the claim below is
 * the *isolated* prepare-path number, and no pool-level speedup is claimed — the
 * same discipline BENCH-001's note asks for.
 */

describe('PERF-001 prepareBuffers clone default', () => {
  it('defaults to handing over the cached buffer, not a slice', () => {
    const pool = new PowerPool(class Stub {}, { size: 1, idleTimeout: 0 });
    const [item] = pool.prepareBuffers([{ a: 1 }]);
    // No transfer list in this mode, which is what keeps the cache entry alive.
    expect(item.transfer).toBeUndefined();
    pool.dispose();
  });

  it('does not detach or empty the cached buffer across repeated sends', () => {
    // The invariant that makes `clone: false` safe. With no transfer list the
    // runtime copies, so the cache entry must survive — and a detached buffer
    // reports `byteLength 0`, which is the only way to see this go wrong.
    const pool = new PowerPool(class Stub {}, { size: 1, idleTimeout: 0 });
    const message = { payload: 'x'.repeat(200) };
    const first = pool.prepareBuffers([message])[0].message;
    expect(first.byteLength).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) {
      const again = pool.prepareBuffers([message])[0].message;
      expect(again.byteLength).toBe(first.byteLength);
      expect(again.byteLength).toBeGreaterThan(0);
    }
    pool.dispose();
  });

  it('still returns a private transferable copy when clone: true is asked for', () => {
    // The opt-in path is unchanged, and it is the right choice for a caller that
    // wants to keep the payload on this side and hand a detachable buffer over.
    const pool = new PowerPool(class Stub {}, { size: 1, idleTimeout: 0 });
    const message = { payload: 'x'.repeat(200) };
    const a = pool.prepareBuffers([message], { clone: true })[0];
    const b = pool.prepareBuffers([message], { clone: true })[0];
    expect(Array.isArray(a.transfer)).toBe(true);
    expect(a.transfer).toHaveLength(1);
    // Two calls must yield two *distinct* buffers, or the second transfer would
    // hand over one already handed over.
    expect(a.message.buffer).not.toBe(b.message.buffer);
    expect(a.message.byteLength).toBe(b.message.byteLength);
    pool.dispose();
  });

  it('leaves TypedArray and ArrayBuffer messages on the transferable path', () => {
    // Only the encoded-plain-object path changed. A real transferable the caller
    // already owns is still transferred, because slicing it would be a copy the
    // caller did not ask for and cannot benefit from.
    const pool = new PowerPool(class Stub {}, { size: 1, idleTimeout: 0 });
    const buf = new ArrayBuffer(16);
    const [item] = pool.prepareBuffers([buf]);
    expect(item.transfer).toEqual([buf]);
    pool.dispose();
  });
});
