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
    const origTE = global.TextEncoder;
    const origTD = global.TextDecoder;
    try {
      // remove TextEncoder/TextDecoder to force Buffer fallback
      // @ts-ignore
      global.TextEncoder = undefined;
      // @ts-ignore
      global.TextDecoder = undefined;
      const mod = await import('../src/helpers/powerBuffer.js');
      const { o2u8, u82o } = mod;
      const obj = { fallback: true };
      const u8 = o2u8(obj);
      expect(u8).toBeInstanceOf(Uint8Array);
      const decoded = u82o(u8);
      expect(decoded).toEqual(obj);
    } finally {
      // restore
      // @ts-ignore
      global.TextEncoder = origTE;
      // @ts-ignore
      global.TextDecoder = origTD;
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

  it('throws when no encoder/decoder available (simulated)', async () => {
    // reload module with globals removed so getEncoder/getDecoder return null
    vi.resetModules();
    const origTE = global.TextEncoder;
    const origTD = global.TextDecoder;
    const origBuf = global.Buffer;
    try {
      // remove global encoders/Buffer
      // @ts-ignore
      global.TextEncoder = undefined;
      // @ts-ignore
      global.TextDecoder = undefined;
      // @ts-ignore
      global.Buffer = undefined;

      const mod = await import('../src/helpers/powerBuffer.js');
      const { o2u8, u82o } = mod;
      expect(() => o2u8({ a: 1 })).toThrow(/No TextEncoder or Buffer available/);
      const u = new Uint8Array([1, 2, 3]);
      expect(() => u82o(u)).toThrow(/No TextDecoder or Buffer available/);
    } finally {
      // restore
      // @ts-ignore
      global.TextEncoder = origTE;
      // @ts-ignore
      global.TextDecoder = origTD;
      // @ts-ignore
      global.Buffer = origBuf;
    }
  });
});
