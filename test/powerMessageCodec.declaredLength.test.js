import { describe, it, expect } from 'vitest';
import {
  decodeMessage,
  encodeMessage,
  createFrameDecoder,
  HEADER_BYTES,
  CODECS,
  MESSAGE_PROTOCOL_VERSION,
} from '../src/index.js';

/**
 * RT-009 — the codec's declared-length safety, pinned.
 *
 * The row's claim is that the codec **is** safe against a frame lying about its
 * payload size, while the transport is not, and that the safety is worth a test
 * because nothing covers it. Verified before writing the assertion:
 *
 * - `decodeMessage` checks `bytes.length < HEADER_BYTES + length` **before** it
 *   slices, so a frame declaring 4 294 967 295 bytes while carrying 2 throws a
 *   `RangeError` in ~120 µs rather than allocating 4 GB.
 * - The payload is a `subarray` **view**, so even a legitimately large frame
 *   costs no copy.
 *
 * Both are the reason `maxPayloadSizeBytes` belongs on the *transport* helpers
 * and not on the codec: the codec cannot be made to allocate by a lying header,
 * so a limit there would be a check on a number the codec already enforces. The
 * platform, by contrast, materialises the whole frame before the codec sees it,
 * which is the gap the option documents as **detection, not prevention**.
 */

/** A frame whose header declares `declared` bytes and carries `carry` of them. */
function lyingFrame(declared, carry, codecId = CODECS.JSON) {
  const bytes = new Uint8Array(HEADER_BYTES + carry);
  bytes[0] = MESSAGE_PROTOCOL_VERSION;
  bytes[1] = codecId;
  new DataView(bytes.buffer).setUint32(2, declared, true);
  return bytes;
}

describe('RT-009: the codec rejects a frame that lies about its payload size', () => {
  it('throws rather than allocating for a frame declaring 4 GB and carrying 2 bytes', () => {
    // The headline. `declare 4294967295, carry 2` is what a hostile or corrupt
    // frame looks like, and the answer must be a throw — an allocation here is a
    // 4 GB crash from an 8-byte input.
    const frame = lyingFrame(0xffffffff, 2);

    expect(() => decodeMessage(frame)).toThrow(RangeError);
    // And the message says which of the two numbers is wrong, because "frame too
    // short" and "payload too large" are different bugs for whoever is reading.
    expect(() => decodeMessage(frame)).toThrow(/declares a 4294967295-byte payload/);
    expect(() => decodeMessage(frame)).toThrow(/only 2 bytes are present/);
  });

  it('throws for a merely oversized frame too, not only an absurd one', () => {
    // A guard that only catches 4 GB declarations is not a guard. 1 MB is
    // ordinary and must behave identically.
    const frame = lyingFrame(1024 * 1024, 2);
    expect(() => decodeMessage(frame)).toThrow(/declares a 1048576-byte payload/);
  });

  it('does not throw for a frame that declares exactly what it carries', () => {
    // The off-by-one boundary. A guard of `bytes.length <= HEADER_BYTES + length`
    // instead of `<` would reject every valid frame, so the boundary is pinned.
    const body = new Uint8Array(8).fill(7);
    const valid = encodeMessage(body, { codec: 'raw' });
    expect(valid.length).toBe(HEADER_BYTES + body.length);

    const decoded = decodeMessage(valid);
    expect(decoded.byteLength).toBe(valid.length);
    expect(decoded.value).toEqual(body);
  });

  it('rejects a lying frame in raw as well as json', () => {
    // Both codecs go through the same length check, and a guard on one path only
    // would leave the other as the way in.
    for (const codecId of [CODECS.JSON, CODECS.RAW]) {
      expect(() => decodeMessage(lyingFrame(0xffffffff, 1, codecId))).toThrow(/declares/);
    }
  });

  it('buffers a lying frame without allocating, and maxFrameBytes is what bounds it', () => {
    // **This is the streaming half, and it behaves differently on purpose.**
    // `decodeMessage` sees a whole frame and can say "truncated"; the decoder
    // cannot, because more bytes may still arrive — a frame declaring 2 GB after
    // two bytes is indistinguishable from a slow peer. So it buffers and waits.
    //
    // That is only safe because it does not *pre-allocate* the declared size.
    // Measured: an 8-byte input declaring 4 294 967 295 bytes moves the heap by
    // **0.0 MB**, because the buffer grows with what actually arrives.
    //
    // The bound is `maxFrameBytes`, and it is **required** — omitting it throws,
    // with a message that says exactly this: a peer that sends a header and stops
    // would otherwise pin the buffer at whatever size it named. So the exposure is
    // a slow accumulation over time rather than an instant allocation, and the
    // library refuses the configuration that allows it rather than defaulting it.
    const lying = lyingFrame(0xffffffff, 2);

    const unbounded = createFrameDecoder({ maxFrameBytes: Infinity });
    const before = process.memoryUsage().heapUsed;
    expect(unbounded.push(lying), 'waits rather than guessing truncation').toEqual([]);
    const allocated = process.memoryUsage().heapUsed - before;
    expect(
      allocated,
      `8 bytes of input must not reserve 4 GB (moved ${(allocated / 1024 / 1024).toFixed(1)} MB)`
    ).toBeLessThan(1024 * 1024);

    // With a real bound, the same frame is refused on arrival.
    expect(() => createFrameDecoder({ maxFrameBytes: 65536 }).push(lying)).toThrow(
      /declares 4294967301 bytes, over the maxFrameBytes limit of 65536/
    );
  });

  it('refuses to create a decoder with no maxFrameBytes at all', () => {
    // **Required, not defaulted.** The failure this prevents is slow rather than
    // instant — a peer that sends a header and stops pins the buffer at whatever
    // size it named — which is exactly the kind of thing a default would have
    // hidden. Pinned because changing the default to `Infinity` would be a
    // one-line change with no other test failing.
    expect(() => createFrameDecoder()).toThrow(TypeError);
    expect(() => createFrameDecoder({})).toThrow(/requires `maxFrameBytes`/);
    // And the message must name the escape hatch, so a caller who genuinely wants
    // the risk can take it deliberately.
    expect(() => createFrameDecoder({})).toThrow(/Pass `Infinity` to accept that risk/);
  });

  it('slices a view, so a large valid frame costs no copy', () => {
    // The second half of "the codec is safe": even a *legitimate* 1 MB payload is
    // not duplicated. This is what makes a codec-side size limit redundant with
    // the check it already performs.
    const payload = new Uint8Array(1024 * 1024).fill(3);
    const frame = encodeMessage(payload, { codec: 'raw' });

    const decoded = decodeMessage(frame, { rawAsBytes: true });

    expect(decoded.value.length).toBe(payload.length);
    // Shared buffer, not a copy: the view points into the frame.
    expect(decoded.value.buffer).toBe(frame.buffer);
  });

  it('refuses a frame over maxFrameBytes before buffering it', () => {
    // The decoder's own ceiling, which is where a *bounds* check legitimately
    // belongs — unlike the codec, which has nothing to allocate.
    const payload = new Uint8Array(1024).fill(1);
    const frame = encodeMessage(payload, { codec: 'raw' });
    const decoder = createFrameDecoder({ maxFrameBytes: 64 });

    expect(() => decoder.push(frame)).toThrow(
      /declares 1030 bytes, over the maxFrameBytes limit of 64/
    );
  });
});
