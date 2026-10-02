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
