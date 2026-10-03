/**
 * Regression tests for `frameEncodedJson` input coercion (BUG-029).
 *
 * The original guard was `json instanceof Uint8Array`, which rejects anything
 * that is byte-like but not literally a `Uint8Array` - a `DataView`, an
 * `Int8Array`, a `Buffer`, or a `Uint8Array` built in another realm.
 *
 * That mattered because of how the failure surfaced. `PowerPool`
 * `_prepareForTransfer` wraps the call in a `catch` that falls back to posting
 * the message unframed, so a rejected input silently downgraded a `framed`
 * pool to the 1.x bare-JSON wire format while `_messageCodec` still reported
 * `'framed'`. The worker only found out much later, inside `decodeMessage`,
 * with `unsupported protocol version 123 (expected 1)` - an error that points
 * nowhere near the real cause.
 *
 * The realm-crossing half of this cannot be reproduced from here: a
 * `Uint8Array` produced by a host `TextEncoder` *is* an `instanceof` the host
 * realm's `Uint8Array`, so the bug only fires when the checking function and
 * the array come from different realms. That case is covered end to end by
 * `test/umd.bundle.test.js`, which loads the built bundle into a `node:vm`
 * context with a host-realm `TextEncoder` injected - the same shape as an
 * iframe, a `worker_threads` context, or a test-runner sandbox.
 *
 * @see src/helpers/powerMessageCodec.js
 */
import { describe, it, expect } from 'vitest';
import {
  frameEncodedJson,
  decodeMessage,
  decodeInbound,
  encodeMessage,
  frameTransferList,
  isRawPayload,
} from '../src/index.js';

const JSON_DOC = '{"hello":"world"}';
const EXPECTED = { hello: 'world' };

describe('frameEncodedJson input coercion (BUG-029)', () => {
  it('accepts a Uint8Array, as before', () => {
    const bytes = new TextEncoder().encode(JSON_DOC);
    expect(decodeMessage(frameEncodedJson(bytes)).value).toEqual(EXPECTED);
  });

  it('accepts a JSON string, as before', () => {
    expect(decodeMessage(frameEncodedJson(JSON_DOC)).value).toEqual(EXPECTED);
  });

  it('accepts a non-Uint8Array view, which `instanceof` rejected', () => {
    // The behaviour change: the guard is now "is this byte-like", not "is this
    // exactly a Uint8Array".
    const bytes = new TextEncoder().encode(JSON_DOC);

    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(dataView).not.toBeInstanceOf(Uint8Array);
    expect(decodeMessage(frameEncodedJson(dataView)).value).toEqual(EXPECTED);

    const int8 = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(int8).not.toBeInstanceOf(Uint8Array);
    expect(decodeMessage(frameEncodedJson(int8)).value).toEqual(EXPECTED);
  });

  it('accepts a Node Buffer without copying twice', () => {
    // `Buffer` extends `Uint8Array`, so this passed before too - kept because
    // Node pools hand out Buffers and a silent `JSON.stringify(Buffer)` path
    // would be a cache-poisoning bug.
    const buf = Buffer.from(JSON_DOC, 'utf8');
    expect(decodeMessage(frameEncodedJson(buf)).value).toEqual(EXPECTED);
  });

  it('rejects values that are not byte-like at all', () => {
    expect(() => frameEncodedJson(42)).toThrow(TypeError);
    expect(() => frameEncodedJson(null)).toThrow(TypeError);
    expect(() => frameEncodedJson(undefined)).toThrow(TypeError);
    expect(() => frameEncodedJson({ not: 'bytes' })).toThrow(TypeError);
    expect(() => frameEncodedJson([1, 2, 3])).toThrow(TypeError);
  });

  it('the error names both accepted forms', () => {
    // A vague TypeError is what made the original bug expensive to diagnose.
    expect(() => frameEncodedJson({})).toThrow(/Uint8Array|JSON string/);
  });

  it('isRawPayload agrees with what frameEncodedJson accepts', () => {
    const bytes = new TextEncoder().encode(JSON_DOC);
    expect(isRawPayload(bytes)).toBe(true);
    expect(isRawPayload(new DataView(bytes.buffer))).toBe(true);
    expect(isRawPayload({})).toBe(false);
    expect(isRawPayload('{"a":1}')).toBe(false);
  });

  it('a frame built from a DataView is byte-identical to one from a Uint8Array', () => {
    const bytes = new TextEncoder().encode(JSON_DOC);
    const fromView = frameEncodedJson(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    );
    const fromU8 = frameEncodedJson(bytes);
    expect(Array.from(fromView)).toEqual(Array.from(fromU8));
  });
});

describe('RT-024: decodeInbound names the frame fault instead of blaming JSON', () => {
  // A version-2 frame used to fall through to the legacy-JSON fallback and come
  // back as `SyntaxError: Unexpected token`, and a truncated frame did the same.
  // Both are the outcomes the comment above the guard said this path ruled out,
  // and neither is actionable by a caller: the message names neither the frame
  // nor the version.
  //
  // The discriminator is the one the class JSDoc already leans on — no JSON
  // document starts with a control byte that is not whitespace — so these bodies
  // are frames, and the legacy paths below are asserted in the same test because
  // the guard must not catch them.
  it('reports an unsupported protocol version as a version RangeError', () => {
    expect(() => decodeInbound(new Uint8Array([2, 0, 2, 0, 0, 0, 123, 125]))).toThrow(
      /unsupported protocol version 2 \(expected 1\)/
    );
  });

  it('reports a truncated frame as such, naming the header', () => {
    expect(() => decodeInbound(new Uint8Array([1, 0, 2]))).toThrow(/truncated frame/);
  });

  it('still decodes every legacy bare-JSON body', () => {
    const enc = new TextEncoder();
    for (const body of [JSON.stringify({ a: 1 }), '  ' + JSON.stringify({ a: 1 }), '123', '"hi"']) {
      expect(decodeInbound(enc.encode(body)).codec, body.slice(0, 12)).toBe('legacy');
    }
    expect(decodeInbound(encodeMessage('hello')).value).toBe('hello');
  });
});

describe('RT-022: frameTransferList never hands back the wrong buffer', () => {
  // Both cases were wrong answers rather than slow ones. A SAB-backed frame put
  // the SharedArrayBuffer in the list and `postMessage` threw DOMException:
  // Found invalid value in transferList. A view into a slab named the whole
  // buffer, so a 6-byte frame in a 16-byte slab transferred all 16 and left the
  // caller with a detached slab — measured, slab.byteLength === 0 afterwards.
  it('leaves a SAB-backed frame out of the list so the post succeeds', () => {
    const frame = new Uint8Array(new SharedArrayBuffer(8));
    const list = frameTransferList(frame);
    expect(list, 'a SharedArrayBuffer is not transferable').toEqual([]);
    // The post is the assertion: naming the SAB is what threw.
    expect(() => structuredClone(frame, { transfer: list })).not.toThrow();
  });

  it('refuses a partial view rather than detaching the caller buffer', () => {
    const slab = new Uint8Array(16);
    expect(() => frameTransferList(slab.subarray(4, 10))).toThrow(/refusing to build/);
    // Offset 0 is not sufficient on its own — a length shorter than the buffer is
    // the same hazard, and it is the case a naive `byteOffset` check would miss.
    expect(() => frameTransferList(new Uint8Array(slab.buffer, 0, 8))).toThrow(/refusing to build/);
    expect(slab.byteLength, 'and nothing was detached').toBe(16);
  });

  it('still transfers a frame that fills its buffer', () => {
    const frame = new Uint8Array(8);
    expect(frameTransferList(frame)).toEqual([frame.buffer]);
  });
});
