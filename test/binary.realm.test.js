import { describe, it, expect, beforeAll } from 'vitest';
import vm from 'node:vm';
import { decodeInbound, decodeMessage, encodeMessage, isRawPayload, u82o } from '../src/index.js';
import { isArrayBuffer, o2u8 } from '../src/helpers/powerBuffer.js';

/**
 * WRK-006: a bare `ArrayBuffer` from another realm was rejected, mangled, or
 * silently replaced — and one of those was silent corruption.
 *
 * The class already had a fix in it: `frameEncodedJson`'s comment records a real
 * incident where a realm-bound `json instanceof Uint8Array` made
 * `PowerPool._prepareForTransfer` downgrade a message to bare JSON while still
 * reporting `messageCodec: 'framed'`. **Views** were safe — `ArrayBuffer.isView`
 * is realm-independent — which is why that fix looked like it covered the file.
 * **Bare buffers** were not, and the gap was in five places.
 *
 * `node:vm` gives a genuine second realm. A hand-rolled `{byteLength: n}` stand-in
 * would be worse than useless here: `new Uint8Array()` accepts one of those, so a
 * fake would pass for the wrong reason and the spoof-rejection test would prove
 * nothing.
 */
let realm;
const foreign = (src) => vm.runInContext(src, realm);

beforeAll(() => {
  realm = vm.createContext({});
});

/** `{"a":1}` as bytes — valid JSON, so it exercises the JSON paths too. */
const JSON_BYTES = [123, 34, 97, 34, 58, 49, 125];

describe('WRK-006: the fixture is a real cross-realm ArrayBuffer', () => {
  it('fails instanceof in this realm but is a genuine buffer', () => {
    const buf = foreign(`new Uint8Array([${JSON_BYTES}]).buffer`);
    expect(buf instanceof ArrayBuffer, 'the premise of the whole row').toBe(false);
    expect(buf.byteLength).toBe(7);
    // A genuine buffer, not an array-like impostor: `Symbol.toStringTag` lies here
    // on purpose, see the spoof test below.
    expect(Object.prototype.toString.call(buf)).toBe('[object ArrayBuffer]');
  });
});

describe('WRK-006: isArrayBuffer is realm-safe and unforgeable', () => {
  it('accepts a local and a foreign buffer alike', () => {
    expect(isArrayBuffer(new ArrayBuffer(4))).toBe(true);
    expect(isArrayBuffer(foreign('new ArrayBuffer(4)'))).toBe(true);
  });

  it('rejects a Symbol.toStringTag impostor', () => {
    // The reason `Object.prototype.toString` is not the answer. It reports
    // `[object ArrayBuffer]` for a plain object, **and `new Uint8Array()` accepts
    // that object**, so a toString-based check converts a spoof into silent
    // corruption rather than a rejection. `Reflect.get` on the spec's `byteLength`
    // accessor performs the internal-slot check and throws for the impostor.
    const spoof = { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 8 };
    expect(Object.prototype.toString.call(spoof)).toBe('[object ArrayBuffer]');
    expect(isArrayBuffer(spoof), 'must not be fooled by the tag').toBe(false);
    expect(isRawPayload(spoof)).toBe(false);
  });

  it('rejects the non-buffers it used to wave through or crash on', () => {
    for (const v of [
      null,
      undefined,
      0,
      '',
      'AB',
      {},
      [],
      new Uint8Array(2),
      new DataView(new ArrayBuffer(2)),
    ])
      expect(isArrayBuffer(v)).toBe(false);
  });
});

describe('WRK-006: the raw encoder no longer eats a foreign buffer', () => {
  it('produces byte-identical frames for local and foreign bare buffers', () => {
    // **The corruption test.** The raw path read
    // `value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, …)`,
    // so a bare foreign buffer failed the test, took the *view* branch, and read
    // `.buffer` off a buffer — which is `undefined`. The payload became empty and
    // the frame decoded to `{}` while reporting success.
    const local = new Uint8Array(JSON_BYTES).buffer;
    const remote = foreign(`new Uint8Array([${JSON_BYTES}]).buffer`);

    const a = encodeMessage(local);
    const b = encodeMessage(remote);

    expect(b.length).toBe(a.length);
    expect(Array.from(b)).toEqual(Array.from(a));
    // And the payload is the caller's bytes, not an empty frame body.
    expect(decodeMessage(b).value.length).toBe(JSON_BYTES.length);
  });

  it('selects the raw codec for a foreign bare buffer', () => {
    expect(isRawPayload(foreign(`new Uint8Array([${JSON_BYTES}]).buffer`))).toBe(true);
  });

  it('round-trips a foreign view as before', () => {
    // `isView` was always realm-safe, so this must keep working — pinned so the
    // `isArrayBuffer` change cannot regress the case that already worked.
    const view = foreign(`new Uint8Array([${JSON_BYTES}])`);
    expect(isRawPayload(view)).toBe(true);
    expect(decodeMessage(encodeMessage(view)).value.length).toBe(JSON_BYTES.length);
  });
});

describe('WRK-006: the decode side accepts a foreign bare buffer', () => {
  it('decodeMessage and decodeInbound both take it', () => {
    const buf = foreign(`new Uint8Array([${JSON_BYTES}]).buffer`);
    // `toBytes` had the same `instanceof`, so a bare foreign buffer reached
    // `throw new TypeError('expected a Uint8Array, ArrayBuffer or DataView')`.
    expect(decodeMessage(encodeMessage(buf)).value.length).toBe(JSON_BYTES.length);
    expect(decodeInbound(buf).value).toEqual({ a: 1 });
  });
});

describe('WRK-006: u82o and o2u8 accept a foreign bare buffer', () => {
  it('u82o decodes it', () => {
    // Before the fix this threw
    // `TypeError: Unsupported input to u82o, expected ArrayBuffer/TypedArray/Buffer`
    // where the identical local buffer decoded.
    expect(u82o(foreign(`new Uint8Array([${JSON_BYTES}]).buffer`))).toEqual({ a: 1 });
    expect(u82o(new Uint8Array(JSON_BYTES).buffer)).toEqual({ a: 1 });
  });

  it('o2u8 still encodes ordinary values', () => {
    expect(o2u8({ a: 1 }).length).toBe(7);
  });

  it('u82o still accepts a cross-realm SharedArrayBuffer', () => {
    // `isSharedBuffer` was `instanceof SharedArrayBuffer`, which is realm-bound
    // for the same reason. A foreign SAB carrying the JSON decodes; the control is
    // a same-realm SAB, whose rejection would mean the brand check is over-eager.
    const sab = foreign(`new SharedArrayBuffer(${JSON_BYTES.length})`);
    new Uint8Array(sab).set(JSON_BYTES);
    expect(u82o(sab)).toEqual({ a: 1 });

    const localSab = new SharedArrayBuffer(JSON_BYTES.length);
    new Uint8Array(localSab).set(JSON_BYTES);
    expect(u82o(localSab)).toEqual({ a: 1 });
  });
});
