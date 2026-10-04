import { describe, it, expect, vi } from 'vitest';

describe('powerBuffer', () => {
  it('encodes and decodes plain objects', async () => {
    const mod = await import('../src/helpers/powerBuffer.js');
    const { o2u8, u82o } = mod;
    const obj = { a: 1, b: 'x' };
    const u8 = o2u8(obj);
    expect(u8).toBeInstanceOf(Uint8Array);
    const decoded = u82o(u8);
    expect(decoded).toEqual(obj);
  });

  it('accepts ArrayBuffer and returns Uint8Array view', async () => {
    const { o2u8 } = await import('../src/helpers/powerBuffer.js');
    const buf = new ArrayBuffer(4);
    const view = new Uint8Array(buf);
    view[0] = 1;
    const u8 = o2u8(buf);
    expect(u8).toBeInstanceOf(Uint8Array);
    expect(u8[0]).toBe(1);
  });

  it('o2b and b2o roundtrip', async () => {
    const { o2b, b2o } = await import('../src/helpers/powerBuffer.js');
    const obj = { z: [1, 2, 3], s: 'hello' };
    const ab = o2b(obj);
    expect(ab).toBeInstanceOf(ArrayBuffer);
    const out = b2o(ab);
    expect(out).toEqual(obj);
  });

  it('falls back to Buffer-based encoder/decoder when TextEncoder/TextDecoder are absent', async () => {
    // Reload module with globals stubbed
    vi.resetModules();
    // `vi.stubGlobal` rather than saving the originals and assigning them back.
    // The hand-written restore is what `require-atomic-updates` fires on: the
    // value is read, `await import` yields, and it is written back afterwards.
    // It is also the mechanism `WorkerAgnostic.browser.test.js` already uses in
    // this repo, and it restores the original property descriptor — so a global
    // that was absent stays absent instead of being assigned `undefined`.
    //
    // `undefined` rather than a deletion, because `powerBuffer` asks
    // `typeof globalThis.TextEncoder === 'function'`; a missing key would answer
    // the same way, but `stubGlobal` cannot express a deletion portably and the
    // distinction is not one this code path has.
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    try {
      const mod = await import('../src/helpers/powerBuffer.js');
      const { o2u8, u82o } = mod;
      const obj = { fallback: true };
      const u8 = o2u8(obj);
      expect(u8).toBeInstanceOf(Uint8Array);
      const decoded = u82o(u8);
      expect(decoded).toEqual(obj);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns the same Uint8Array instance when passed through', async () => {
    const { o2u8 } = await import('../src/helpers/powerBuffer.js');
    const ua = new Uint8Array([1, 2, 3]);
    const out = o2u8(ua);
    expect(out).toBe(ua);
  });

  it('handles typed-array views and o2b produces a sliced ArrayBuffer when offset present', async () => {
    const mod = await import('../src/helpers/powerBuffer.js');
    const { o2u8, o2b } = mod;
    const buf = new ArrayBuffer(8);
    const view = new Uint8Array(buf, 2, 4);
    view.set([9, 8, 7, 6]);
    const u8 = o2u8(view);
    expect(u8).toBeInstanceOf(Uint8Array);
    const ab = o2b(view);
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(ab.byteLength).toBe(u8.byteLength);
    expect(ab).not.toBe(u8.buffer);
  });

  it('u82o accepts Node Buffer and decodes to object', async () => {
    const { u82o } = await import('../src/helpers/powerBuffer.js');
    const obj = { foo: 'bar' };
    // Node Buffer path
    const buf = Buffer.from(JSON.stringify(obj));
    const out = u82o(buf);
    expect(out).toEqual(obj);
  });

  it('u82o throws for unsupported input types', async () => {
    const { u82o } = await import('../src/helpers/powerBuffer.js');
    expect(() => u82o('not-a-buffer')).toThrow(TypeError);
  });

  it('o2u8 uses a pre-stringified value when provided (avoids re-stringify)', async () => {
    const { o2u8, u82o } = await import('../src/helpers/powerBuffer.js');
    const obj = { a: 1 };
    const pre = JSON.stringify({ a: 2 }); // intentionally different
    const u8 = o2u8(obj, pre);
    // The encoded bytes must reflect `pre`, not a fresh JSON.stringify(obj).
    expect(u82o(u8)).toEqual({ a: 2 });
  });

  it('o2u8 ignores preStringified for non-plain objects (Uint8Array passthrough)', async () => {
    const { o2u8 } = await import('../src/helpers/powerBuffer.js');
    const ua = new Uint8Array([4, 5, 6]);
    const out = o2u8(ua, '{"ignored":true}');
    expect(out).toBe(ua);
  });

  it('throws when no encoder/decoder available (simulated)', async () => {
    // reload module with globals removed so getEncoder/getDecoder return null
    vi.resetModules();
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('TextDecoder', undefined);
    vi.stubGlobal('Buffer', undefined);
    try {
      const mod = await import('../src/helpers/powerBuffer.js');
      const { o2u8, u82o } = mod;
      expect(() => o2u8({ a: 1 })).toThrow(/No TextEncoder or Buffer available/);
      const u = new Uint8Array([1, 2, 3]);
      expect(() => u82o(u)).toThrow(/No TextDecoder or Buffer available/);
    } finally {
      // The hand-written restore this replaced assigned `undefined` back onto
      // `global.Buffer` when the original had been captured as `undefined`, which
      // leaves the global *present but undefined* — a different thing from absent,
      // and one that would leak into every later test in the file. `unstubAllGlobals`
      // restores the descriptor instead.
      vi.unstubAllGlobals();
    }
  });
});

describe('PERF-005: o2u8 refuses what JSON cannot represent, and knows a SAB', () => {
  // `JSON.stringify` returns **undefined** for `undefined`, a function and a
  // Symbol, and `TextEncoder.encode` has a WebIDL default that turns that into a
  // **zero-byte** frame. The value crossed the wire as nothing and surfaced at the
  // far end as `SyntaxError: Unexpected end of JSON input`, naming neither the value
  // nor the encoder. Asserted on the byte count because that is the whole defect:
  // the old answer was a valid Uint8Array of length 0, which is why nothing threw
  // here at all.
  it('throws instead of encoding a zero-byte frame', async () => {
    const { o2u8 } = await import('../src/helpers/powerBuffer.js');
    for (const [label, value] of [
      ['undefined', undefined],
      ['a function', () => {}],
      ['a Symbol', Symbol('s')],
    ]) {
      expect(() => o2u8(value), label).toThrow(TypeError);
    }
  });

  it('encodes a SharedArrayBuffer as its bytes, not as {}', async () => {
    const { o2u8, u82o } = await import('../src/helpers/powerBuffer.js');
    // A SharedArrayBuffer is deliberately not an ArrayBuffer, so it fell through
    // to JSON.stringify and became the two bytes `{}` - a value the caller
    // certainly did not mean, with nothing to say so.
    const sab = new SharedArrayBuffer(4);
    new Uint8Array(sab).set([1, 2, 3, 4]);
    expect(Array.from(o2u8(sab))).toEqual([1, 2, 3, 4]);
    expect(u82o(new TextEncoder().encode(JSON.stringify([1, 2, 3, 4])))).toEqual([1, 2, 3, 4]);
  });

  it('still encodes ordinary values and the pre-stringified path', async () => {
    const { o2u8, u82o } = await import('../src/helpers/powerBuffer.js');
    expect(u82o(o2u8({ a: 1 }))).toEqual({ a: 1 });
    expect(u82o(o2u8({ a: 1 }, '{"a":2}'))).toEqual({ a: 2 });
  });
});

describe('the encoder/decoder verdict is not cached as permanently unavailable', () => {
  // Found while adding PERF-005: `getEncoder()` cached absence as
  // `_encoder = false`, so once any caller saw no encoder, every later call was
  // told `No TextEncoder or Buffer available` for the rest of the process. In this
  // file that was visible as cross-test pollution - a test that stubs
  // `TextEncoder` away poisoned the cache for every test after it. In production
  // the same shape is a host that gains a `TextEncoder` later (a polyfill loaded
  // after first use, or a module instance shared across `vm` contexts) being
  // permanently denied.
  //
  // The positive result is still cached, so this asserts recoverability only.
  it('o2b copies a SAB-backed view, because it promises an owning ArrayBuffer', async () => {
    // PERF-005. `o2u8` returning a SAB-backed view made `o2b`'s zero-copy paths hand
    // back **shared mutable state** under a signature promising an owning
    // `ArrayBuffer` — and `SharedArrayBuffer.prototype.slice` returns another SAB, so
    // the slicing path did not help either. The type ratchet caught this as two
    // errors; the contract is what makes the fix obvious.
    //
    // Asserted on all three properties together, because any one alone is
    // satisfiable by a wrong fix: the *type* of the result, its contents, and the
    // source SAB being left readable (a copy that detached the source would be a
    // different bug).
    const { o2b } = await import('../src/helpers/powerBuffer.js');
    const sab = new SharedArrayBuffer(4);
    new Uint8Array(sab).set([1, 2, 3, 4]);
    const out = o2b(new Uint8Array(sab));
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect(out).not.toBeInstanceOf(SharedArrayBuffer);
    expect(Array.from(new Uint8Array(out))).toEqual([1, 2, 3, 4]);
    expect(new Uint8Array(sab)[0], 'the source SAB is untouched').toBe(1);
  });

  it('throws from u82o when there is no decoder, rather than falling back', async () => {
    // PERF-004. `u82o` carried a second fallback guarded by
    // `typeof TextDecoder !== 'undefined'`, on the line *after* the one that
    // returns `null` — and `getDecoder()` returns `null` only when the runtime has
    // neither `TextDecoder` nor `Buffer`, so the guard could never be true.
    // Deleting it leaves this as the one live no-decoder path, and pinning that
    // is what makes the deletion intentional rather than incidental.
    vi.resetModules();
    vi.stubGlobal('TextDecoder', undefined);
    vi.stubGlobal('Buffer', undefined);
    const { u82o } = await import('../src/helpers/powerBuffer.js');
    expect(() => u82o(new Uint8Array([49])), 'no decoder').toThrow(
      /No TextDecoder or Buffer available to decode object/
    );
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('recovers once an encoder exists again', async () => {
    // A fresh module instance, because the *positive* result is still cached —
    // which is the other half of the contract, and without a reset this test
    // would pass for the wrong reason: an encoder cached by an earlier test is
    // returned without consulting the stubbed globals at all.
    vi.resetModules();
    vi.stubGlobal('TextEncoder', undefined);
    vi.stubGlobal('Buffer', undefined);
    const { o2u8, u82o } = await import('../src/helpers/powerBuffer.js');
    expect(() => o2u8({ a: 1 }), 'no encoder available').toThrow(/No TextEncoder or Buffer/);
    vi.unstubAllGlobals();
    expect(u82o(o2u8({ a: 1 })), 'and recovers once one exists').toEqual({ a: 1 });
    vi.resetModules();
  });
});
