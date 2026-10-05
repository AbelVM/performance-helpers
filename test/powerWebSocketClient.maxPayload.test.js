import { describe, it, expect } from 'vitest';
import { PowerWebSocketClient } from '../src/index.js';
import { encodeMessage } from '../src/index.js';

/**
 * RT-009 — `maxPayloadSizeBytes`, documented as **detection, not prevention**.
 *
 * **The distinction is the deliverable.** By the time a `message` event fires the
 * platform has already received and materialised the whole frame, so nothing at
 * this layer can stop the allocation. The option therefore *reports* an oversized
 * frame and lets it through. A number that reads like a limit and is not one is
 * worse than no number, which is why it is described that way in the option, in
 * the error message, and here.
 *
 * **These tests drive `_handleMessage` directly** rather than a fake socket. The
 * detection, the counter and the error all live in that one method, and the
 * transport wiring around it is already covered by the existing client tests. A
 * fake socket here would be a second, weaker copy of that coverage: the first
 * attempt at one never completed its open handshake and delivered nothing at all,
 * which would have made these four cases pass vacuously — the same trap as the
 * `PLAN_ROW` regex that matched nothing and left every check in its file passing.
 * Reaching a private to test it directly is the smaller risk, and it is what the
 * cache and queue tests here already do.
 */

/** A frame of roughly `bytes` payload, so the limit can be straddled. */
const frameOf = (bytes) => encodeMessage({ pad: 'x'.repeat(bytes) });

/** A client with the detection wired, and the error and message taps attached. */
function client(options = {}) {
  const errors = [];
  const messages = [];
  const c = new PowerWebSocketClient({
    url: 'ws://example.invalid/',
    autoReconnect: false,
    onError: (e) => errors.push(e),
    onMessage: (m) => messages.push(m),
    ...options,
  });
  return { c, errors, messages };
}

describe('RT-009: maxPayloadSizeBytes reports an oversized frame without stopping it', () => {
  it('reports a frame over the limit and still delivers it', () => {
    // **Both halves, and both matter.** The report is the feature; the delivery
    // is what makes it detection rather than prevention. A later change that
    // "fixes" this into a rejection fails the second assertion, which is the
    // point of writing it here rather than only asserting the count.
    const { c, errors, messages } = client({ maxPayloadSizeBytes: 200 });
    c._handleMessage({ data: frameOf(500) });

    expect(c.stats().oversizeFrames).toBe(1);
    expect(errors, 'the peer is told what arrived').toHaveLength(1);
    expect(messages, 'and the frame is not dropped').toHaveLength(1);
    expect(messages[0]).toEqual({ pad: 'x'.repeat(500) });
  });

  it('says plainly that this is detection and not prevention', () => {
    // The wording is load-bearing: a reader who skims the option name will
    // otherwise assume a guarantee. Both halves of that sentence are asserted.
    const { c, errors } = client({ maxPayloadSizeBytes: 200 });
    c._handleMessage({ data: frameOf(500) });

    const message = String(errors[0].message);
    expect(message).toMatch(/detection, not prevention/);
    expect(message).toMatch(/already received and buffered/);
    expect(message).toMatch(/Bound the payload at the peer that produces it/);
  });

  it('reports nothing for a frame under the limit', () => {
    const { c, errors, messages } = client({ maxPayloadSizeBytes: 100_000 });
    c._handleMessage({ data: frameOf(10) });

    expect(c.stats().oversizeFrames).toBe(0);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);
  });

  it('treats the limit as inclusive, so exactly-at-the-limit is not over it', () => {
    // An off-by-one here would report every frame at the exact limit, which for a
    // caller who set the limit from a known maximum is every frame they send.
    const exact = frameOf(64);
    // The limit is set **from the measured frame**, not from the payload size.
    // The first draft passed `maxPayloadSizeBytes: 4096` alongside a 64-byte body
    // and asserted `exact.length === 4096`; the frame came out 80 bytes, because
    // the JSON envelope and the header are on top of the payload. A hard-coded
    // expected length was asserting a number about the encoder, not about the
    // boundary.
    const { c } = client({ maxPayloadSizeBytes: exact.length });
    c._handleMessage({ data: exact });

    expect(c.stats().oversizeFrames, 'exactly at the limit is not over it').toBe(0);
    c._handleMessage({ data: frameOf(65) }); // one byte more, and over
    expect(c.stats().oversizeFrames).toBe(1);
  });

  it('defaults to Infinity, which disables the report', () => {
    const { c, errors, messages } = client();
    c._handleMessage({ data: frameOf(50_000) });

    expect(c.stats().oversizeFrames).toBe(0);
    expect(errors).toHaveLength(0);
    expect(messages, 'the frame still arrives').toHaveLength(1);
  });

  it('treats 0 as "no check" rather than "report everything"', () => {
    // Two different statements, and a no-limit caller should not have to spell
    // the first one. Without the `min: 0` allowance a 0 would report every frame.
    const { c, errors } = client({ maxPayloadSizeBytes: 0 });
    c._handleMessage({ data: frameOf(1) });

    expect(c.stats().oversizeFrames).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it('rejects a nonsensical limit rather than coercing it', () => {
    // Consistent with the class: a bad number is a caller error, not something to
    // silently substitute a default for.
    expect(() => client({ maxPayloadSizeBytes: 'lots' })).toThrow(TypeError);
    expect(() => client({ maxPayloadSizeBytes: Number.NaN })).toThrow(TypeError);
    expect(() => client({ maxPayloadSizeBytes: -1 })).toThrow(TypeError);
  });

  it('reads the length from a Blob as readily as from bytes', async () => {
    // A `message` event carries a `Blob` for binary frames by default, so a size
    // check that only understood `byteLength` would miss exactly the shape the
    // platform hands out most often. `Blob` is available in Node 18+, which is
    // this project's floor.
    const { c, errors } = client({ maxPayloadSizeBytes: 200 });
    const bytes = frameOf(500);

    // A Blob-shaped stand-in would not exercise the real branch, so use a real one.
    const blob = new Blob([bytes]);
    expect(blob.size, 'the fixture really is Blob-shaped').toBe(bytes.length);

    c._handleMessage({ data: blob });
    await c._settleInbound();

    expect(c.stats().oversizeFrames, 'a Blob is measured, not skipped').toBe(1);
    // **One error, and this assertion was two.** The second used to be
    // `PowerMessageCodec: expected a Uint8Array`, raised because `decodeMessage`
    // cannot read a `Blob` synchronously — documented here as pre-existing
    // behaviour that this row did not ask to fix.
    //
    // **RT-036's note predicted this test would "still pass unchanged" after part 2,
    // and that prediction was wrong.** Its reasoning was that the test drives
    // `_handleMessage` with no recorded refusal — but part 2 does not condition on a
    // recorded refusal, it converts whatever arrives as a `Blob`.
    //
    // So the codec error is **gone rather than replaced**, and the second assertion I
    // wrote here first (`decodeErrors === 1`, on the theory that the converted filler
    // would fail to parse) was wrong: `frameOf(500)` is `encodeMessage` of a 500-byte
    // pad, so it is a *valid* message that merely happens to be large. It converts and
    // it decodes. Asserting 1 would have pinned a decode failure that does not happen.
    //
    // What is left is the size report alone, which is the thing this test exists for —
    // and it is still first, because `frameByteLength` reads a Blob's `.size` before any
    // conversion is attempted.
    expect(errors).toHaveLength(1);
    expect(String(errors[0].message)).toMatch(/detection, not prevention/);
    // A Blob is no longer a decode failure. Before part 2 this read 1.
    expect(c.stats().decodeErrors, 'a Blob converts; it is not unreadable').toBe(0);
    expect(c.stats().received, 'and the oversized frame is still delivered').toBe(1);
  });

  it('counts every oversized frame rather than stopping at the first', () => {
    // A counter that latched would report 1 whatever the peer did, which is the
    // difference between "a peer sent one big frame" and "a peer is flooding me".
    const { c, messages } = client({ maxPayloadSizeBytes: 200 });
    for (let i = 0; i < 4; i += 1) c._handleMessage({ data: frameOf(500) });

    expect(c.stats().oversizeFrames).toBe(4);
    expect(messages).toHaveLength(4);
  });

  it('reports before decoding, so an undecodable frame is still counted', () => {
    // The detection is on the frame, not on the decoded message, so a peer
    // sending garbage at volume shows up in `oversizeFrames` rather than only in
    // `decodeErrors` — which is the signal that tells them apart.
    const { c, messages } = client({ maxPayloadSizeBytes: 10 });
    c._handleMessage({ data: new Uint8Array(4096) });

    expect(c.stats().oversizeFrames).toBe(1);
    expect(messages, 'and it does not decode').toHaveLength(0);
  });
});
