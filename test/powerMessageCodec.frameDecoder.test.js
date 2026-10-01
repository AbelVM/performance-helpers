/**
 * CODEC-001 — `createFrameDecoder()`.
 *
 * The four properties these tests pin come from `review.md` §12.3, and they are
 * the properties rather than the happy path. The happy path — one complete
 * frame in one chunk — is what `decodeMessage` already did, and it is the one
 * case that cannot fail. The failure mode of this feature is **silence**: a
 * decoder that drops a frame, or emits garbage decoded from a half-written
 * payload, passes every test that only checks "does it decode something".
 */
import { describe, it, expect } from 'vitest';
import {
  encodeMessage,
  createFrameDecoder,
  HEADER_BYTES,
  MESSAGE_PROTOCOL_VERSION,
  CODECS,
} from '../src/helpers/powerMessageCodec.js';

/** A decoder with the ceiling every test but the limit tests needs. */
const dec = (options = {}) => createFrameDecoder({ maxFrameBytes: 1 << 16, ...options });

/** Concatenate frames into one buffer, the way a coalescing transport does. */
function coalesce(...frames) {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

/** Push a buffer in fixed-size pieces, so every frame is split. */
function pushInChunksOf(decoder, bytes, size) {
  const out = [];
  for (let at = 0; at < bytes.length; at += size) {
    out.push(...decoder.push(bytes.subarray(at, Math.min(at + size, bytes.length))));
  }
  return out;
}

describe('createFrameDecoder', () => {
  // ─── Property 1: a chunk smaller than the header ───────────────────────────
  //
  // This is the case `decodeMessage` throws on, and it is the *normal* state of
  // a stream about once per frame. Before this existed, a socket reader hit a
  // RangeError at that rate, which is a good way to teach a caller to swallow
  // RangeErrors — including the one that means the peer is actually corrupt.
  it('yields [] for a chunk too short to hold a header, and does not throw', () => {
    const decoder = dec();
    const frame = encodeMessage({ hello: 'world' });
    expect(frame.length).toBeGreaterThan(HEADER_BYTES);

    // One byte at a time through the header — the shape a socket reader sees
    // when a frame lands across several TCP segments.
    for (let sent = 1; sent < HEADER_BYTES; sent++) {
      expect(decoder.push(frame.subarray(sent - 1, sent))).toEqual([]);
    }
    // ...and the frame is still whole once the rest arrives.
    expect(decoder.push(frame.subarray(HEADER_BYTES - 1)).map((f) => f.value)).toEqual([
      { hello: 'world' },
    ]);
  });

  // A large frame arriving in pieces, so the buffer is grown and the read
  // cursor is non-zero for part of it. This is the case the *completeness
  // check* exists for: a frame whose declared length exceeds the bytes received
  // must not be decoded at all, however much room the buffer happens to have.
  //
  // It does not, and this comment used to say it did, pin the `subarray(start,
  // end)` bound in `push`. Mutation says otherwise: dropping the `end` and
  // slicing to the buffer's capacity leaves all 34 tests green, because the
  // `end - start` check runs first and `decodeMessage` is never reached with an
  // incomplete frame. The bounded view is defence in depth, not the guard.
  it('reassembles a frame larger than its buffer, delivered in pieces', () => {
    const decoder = dec();
    // `{"pad":"…","n":1}` is a 17-byte shell around the padding, so 3984 gives a
    // 4000-byte payload and a 4006-byte frame.
    const value = { pad: 'x'.repeat(3984), n: 1 };
    const frame = encodeMessage(value);
    expect(frame.length).toBe(4006);

    const first = decoder.push(frame.subarray(0, 2000));
    expect(first).toEqual([]); // header only — must not be mistaken for a frame
    expect(decoder.pendingBytes).toBe(2000);

    expect(decoder.push(frame.subarray(2000, 4000))).toEqual([]);
    expect(decoder.push(frame.subarray(4000)).map((f) => f.value)).toEqual([value]);
    expect(decoder.pendingBytes).toBe(0);
  });

  // ─── Property 2: every complete frame in a chunk, not the first ────────────
  //
  // The silent-loss case. `decodeMessage` on a two-frame buffer returns the
  // first, reports a `byteLength` smaller than its input, and throws nothing —
  // so the second frame is never looked at and the call site cannot tell.
  it('emits every complete frame in one chunk, not just the first', () => {
    const decoder = dec();
    const a = encodeMessage({ n: 1 });
    const b = encodeMessage({ n: 2 });
    const c = encodeMessage({ n: 3 });

    const frames = decoder.push(coalesce(a, b, c));
    expect(frames.map((f) => f.value)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(decoder.pendingBytes).toBe(0);
  });

  // `byteLength` per frame is what lets a caller reconcile what it pushed with
  // what it got. If it were the whole chunk's length, or a stale one, the two
  // would not add up and this would be an arithmetic coincidence.
  it('reports each frame’s own framed length, and the lengths sum to the chunk', () => {
    const decoder = dec();
    const bytes = coalesce(encodeMessage({ n: 1 }), encodeMessage({ n: 2 }));
    const frames = decoder.push(bytes);
    expect(frames.map((f) => f.byteLength)).toEqual([13, 13]);
    expect(frames.reduce((n, f) => n + f.byteLength, 0)).toBe(bytes.length);
  });

  // ─── Property 3: no re-copy per chunk, and compaction must not change output ─
  //
  // §12.3 asks for this explicitly, and the way to pin "the buffer bookkeeping
  // is right" is to compare against the trivial implementation: same stream,
  // same frames, however it was cut up. `k = 1` is the worst case (every frame
  // split across 6+ pushes, buffer grown and compacted repeatedly) and `k`
  // larger than a frame is the best case (whole frames per chunk). Both must
  // produce the input values, in order.
  it.each([1, 2, 3, 5, 7, 11, 13, 17, 64, 999, 4096])(
    'delivers the same frames whether chunks are %i bytes or the whole stream',
    (k) => {
      const values = Array.from({ length: 40 }, (_, i) => ({ i, pad: 'y'.repeat(i * 37) }));
      const bytes = coalesce(...values.map(encodeMessage));

      const chunked = pushInChunksOf(dec(), bytes, k);
      const whole = dec().push(bytes);

      expect(chunked.map((f) => f.value)).toEqual(values);
      expect(whole.map((f) => f.value)).toEqual(values);
    }
  );

  // A stream that keeps up should not grow its buffer without bound, and the
  // cheap way to see that is that a long stream of small frames still decodes
  // — a leak here is unbounded memory, not a wrong answer, so it is worth a
  // case that runs long enough to show it.
  it('sustains a long stream of small frames without losing or reordering any', () => {
    const decoder = dec();
    const seen = [];
    for (let i = 0; i < 2000; i++) seen.push(...decoder.push(encodeMessage({ i })));
    expect(seen.length).toBe(2000);
    expect(seen[0].value).toEqual({ i: 0 });
    expect(seen[1999].value).toEqual({ i: 1999 });
    expect(decoder.pendingBytes).toBe(0);
  });

  // ─── Property 4: a byte ceiling, checked on the header ─────────────────────
  //
  // RT-009's rule: a limit that sounds like a limit and is not is worse than
  // none. The peer here declares 4 GB in a 6-byte header and then sends
  // nothing. Without the ceiling the decoder buffers the header and waits
  // forever; the point of checking at header time is that `pendingBytes` is
  // still 6 when it gives up — the declared payload was never accepted, let
  // alone allocated.
  it('refuses a frame over maxFrameBytes on its header, before buffering the payload', () => {
    const decoder = dec({ maxFrameBytes: 1024 });
    const hostile = new Uint8Array(HEADER_BYTES);
    hostile[0] = MESSAGE_PROTOCOL_VERSION;
    hostile[1] = CODECS.JSON;
    // 4 GB - 1 declared payload, little-endian.
    hostile[2] = 0xff;
    hostile[3] = 0xff;
    hostile[4] = 0xff;
    hostile[5] = 0x7f;

    expect(() => decoder.push(hostile)).toThrow(RangeError);
    expect(() => decoder.push(hostile)).toThrow(/maxFrameBytes/);
    // Two pushes of a 6-byte header, and not one byte more: the peer declared
    // ~4 GB and this decoder took its word for none of it.
    expect(decoder.pendingBytes).toBe(2 * HEADER_BYTES);
  });

  // A frame exactly at the ceiling is fine. Off-by-one in the comparison would
  // reject a legitimate frame, which is the failure mode of adding the check.
  it('accepts a frame whose total framed length is exactly maxFrameBytes', () => {
    const value = { pad: 'z'.repeat(100) };
    const frame = encodeMessage(value);
    const decoder = dec({ maxFrameBytes: frame.length });
    expect(decoder.push(frame).map((f) => f.value)).toEqual([value]);

    const tooBig = dec({ maxFrameBytes: frame.length - 1 });
    expect(() => tooBig.push(frame)).toThrow(/maxFrameBytes/);
  });

  // The ceiling is per frame, not per chunk: a hub fanning out to many
  // subscribers legitimately coalesces several frames into one socket write,
  // and a chunk-sized ceiling would break that.
  it('bounds one frame, not the whole chunk', () => {
    const decoder = dec({ maxFrameBytes: 64 });
    const values = Array.from({ length: 8 }, (_, n) => ({ n }));
    const bytes = coalesce(...values.map(encodeMessage));
    expect(bytes.length).toBeGreaterThan(64);
    expect(decoder.push(bytes).map((f) => f.value)).toEqual(values);
  });

  // `maxFrameBytes` has no default. The ceiling is the only thing standing
  // between a peer and an unbounded buffer, and a default nobody chose is a
  // limit that sounds like one and is not.
  it('requires maxFrameBytes, and says why', () => {
    expect(() => createFrameDecoder()).toThrow(TypeError);
    expect(() => createFrameDecoder({})).toThrow(/requires `maxFrameBytes`/);
  });

  // A ceiling below the header size could never admit a frame, so accepting it
  // would be a decoder that always throws. `Infinity` is the documented opt-out
  // and must actually work, or the escape hatch is a lie.
  it('rejects a ceiling that cannot hold a header, and honours Infinity', () => {
    expect(() => dec({ maxFrameBytes: HEADER_BYTES - 1 })).toThrow(/maxFrameBytes/);
    // Fractional: a limit that counts bytes must be a whole number (PERF-002).
    expect(() => dec({ maxFrameBytes: 1024.5 })).toThrow(/whole number/);

    const unbounded = dec({ maxFrameBytes: Infinity });
    const value = { pad: 'w'.repeat(2000) };
    expect(unbounded.push(encodeMessage(value)).map((f) => f.value)).toEqual([value]);
  });

  // ─── End of stream: the remainder, and naming the shortfall ────────────────
  it('returns the unconsumed remainder at flush, and zero when clean', () => {
    const decoder = dec();
    const frame = encodeMessage({ hello: 'world' });
    decoder.push(frame.subarray(0, 10));

    const tail = decoder.flush();
    expect(tail).toBeInstanceOf(Uint8Array);
    expect(Array.from(tail)).toEqual(Array.from(frame.subarray(0, 10)));

    // A copy, not a view: the caller may keep it while the decoder is reused.
    decoder.push(frame.subarray(10));
    expect(Array.from(tail)).toEqual(Array.from(frame.subarray(0, 10)));
    expect(decoder.flush().length).toBe(0);
  });

  it('names the shortfall when flush is asked to be strict', () => {
    const frame = encodeMessage({ hello: 'world' });
    const decoder = dec();
    decoder.push(frame.subarray(0, frame.length - 3));

    expect(() => decoder.flush({ strict: true })).toThrow(RangeError);
    expect(() => decoder.flush({ strict: true })).toThrow(
      new RegExp(`${frame.length - 3} of ${frame.length} bytes buffered`)
    );
  });

  // Below a header there is no declared length to quote, so the message says
  // that instead of inventing one. Both are the end of a dead stream; only one
  // of them can name a target.
  it('says so when the stream ended before a whole header', () => {
    const decoder = dec();
    decoder.push(new Uint8Array([1, 0, 5]));
    expect(() => decoder.flush({ strict: true })).toThrow(/not even a whole header/);
  });

  // ─── Option plumbing ───────────────────────────────────────────────────────
  // `strict` and `rawAsBytes` are `decodeMessage`'s, passed per frame. If the
  // plumbing were dropped they would silently default to the safe reading, so
  // a rolling upgrade would stop working with no error anywhere.
  it('passes strict and rawAsBytes through to each frame', () => {
    const version2 = encodeMessage({ n: 1 });
    version2[0] = 2;

    expect(() => dec().push(version2)).toThrow(/unsupported protocol version/);
    expect(
      dec({ strict: false })
        .push(version2)
        .map((f) => f.value)
    ).toEqual([{ n: 1 }]);

    const raw = encodeMessage(new Uint8Array([1, 2, 3]));
    const asBytes = dec({ rawAsBytes: true }).push(raw)[0].value;
    expect(asBytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(asBytes)).toEqual([1, 2, 3]);
  });

  // A characterisation, and the sharp edge of `rawAsBytes` on a stream: the
  // view aliases the decoder's own buffer, so the next push overwrites it. With
  // a complete frame there was one call and the frame was the caller's; a stream
  // has a next call. Pinned so that keeping it is a decision.
  it('rawAsBytes views are invalidated by the next push — pinned, not fixed', () => {
    const decoder = dec({ rawAsBytes: true });
    const view = decoder.push(encodeMessage(new Uint8Array([1, 2, 3])))[0].value;
    expect(Array.from(view)).toEqual([1, 2, 3]);

    decoder.push(encodeMessage(new Uint8Array([9, 9, 9])));
    expect(Array.from(view)).not.toEqual([1, 2, 3]);
  });

  // The default copies the payload out, which is the difference: the value
  // outlives the stream. `decodeMessage`'s `slice()`-by-default exists for the
  // same reason, and losing it here would be invisible until a caller reused a
  // payload after the next message arrived.
  it('copies payloads by default, so they outlive later pushes', () => {
    const decoder = dec();
    const first = decoder.push(encodeMessage(new Uint8Array([1, 2, 3])))[0].value;
    decoder.push(encodeMessage(new Uint8Array([9, 9, 9])));
    expect(Array.from(first)).toEqual([1, 2, 3]);
  });

  // The same coercion as `decodeMessage`, so a transport handing over an
  // `ArrayBuffer` or a `DataView` gets the same error rather than a new one.
  it('rejects a chunk that is not bytes, with decodeMessage’s TypeError', () => {
    const decoder = dec();
    expect(() => decoder.push('not bytes')).toThrow(TypeError);
    expect(() => decoder.push(null)).toThrow(/Uint8Array, ArrayBuffer or DataView/);
  });

  // An empty chunk is a thing a stream reader can be handed, and it must be the
  // no-op it looks like. This is property 1 at its limit.
  it('treats an empty chunk as a no-op', () => {
    const decoder = dec();
    const frame = encodeMessage({ n: 1 });
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(frame).map((f) => f.value)).toEqual([{ n: 1 }]);
  });

  // ─── The coalesced-then-partial shape, which is the ordinary socket case ────
  //
  // Every test above either decoded a whole chunk or left the cursor at 0 with
  // a partial frame behind it. A real socket does the third thing: it delivers
  // a chunk carrying several whole frames *and* the start of the next one. That
  // is the only state in which the read cursor is non-zero while bytes are
  // still buffered, and three things are only observable there — `pendingBytes`
  // has to subtract the consumed frames, `reset()` has to rewind the read
  // cursor as well as the write cursor, and a `flush()` result has to be a copy
  // rather than a window onto a buffer that is about to be written over.
  it('handles a chunk carrying whole frames and the start of the next', () => {
    const decoder = dec();
    const a = encodeMessage({ n: 1 });
    const b = encodeMessage({ n: 2 });
    const half = Math.floor(b.length / 2);

    const frames = decoder.push(coalesce(a, b).subarray(0, a.length + half));
    expect(frames.map((f) => f.value)).toEqual([{ n: 1 }]);
    // `half`, not `a.length + half`: the live count excludes what was consumed.
    expect(decoder.pendingBytes).toBe(half);
    expect(decoder.flush().length).toBe(half);

    expect(decoder.push(b.subarray(half)).map((f) => f.value)).toEqual([{ n: 2 }]);
    expect(decoder.pendingBytes).toBe(0);
  });

  // `reset()` has to move both cursors. Clearing only the write cursor leaves
  // the read cursor ahead of it, `end - start` goes negative, and the decoder
  // silently decodes nothing ever again — no throw, no frames.
  it('reset() rewinds the read cursor as well as the write cursor', () => {
    const decoder = dec();
    const a = encodeMessage({ n: 1 });
    const b = encodeMessage({ n: 2 });
    decoder.push(coalesce(a, b).subarray(0, a.length + 4));
    expect(decoder.pendingBytes).toBe(4);

    decoder.reset();
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(b).map((f) => f.value)).toEqual([{ n: 2 }]);
  });

  // The remainder is handed to a caller who may log it, forward it, or keep it
  // for diagnostics while the decoder carries on. A view onto the decoder's own
  // buffer reports whatever lands there next, which for a stream is the very
  // next message.
  it('hands back a copy of the remainder, not a window onto the live buffer', () => {
    const decoder = dec();
    const frame = encodeMessage({ hello: 'world' });
    decoder.push(frame.subarray(0, 10));
    const tail = decoder.flush();
    const before = Array.from(tail);

    // Reuse the decoder: `reset` rewinds to 0, so the next frame is written over
    // exactly the bytes `tail` is looking at.
    decoder.reset();
    decoder.push(encodeMessage({ completely: 'different', pad: 'q'.repeat(40) }));

    expect(Array.from(tail)).toEqual(before);
  });

  // ─── Recovery ──────────────────────────────────────────────────────────────
  // Once a frame is mis-parsed the length prefix is no longer trustworthy, so
  // there is no resynchronisation to offer — only a reset. A throw therefore
  // leaves the buffer intact and the decoder permanently stuck, which the
  // caller has to be told about in a test rather than in a comment.
  it('stays stuck after a protocol error until reset, then recovers', () => {
    const decoder = dec();
    const bad = encodeMessage({ n: 1 });
    bad[0] = 9; // unsupported version
    decoder.push(bad.subarray(0, 4));

    expect(() => decoder.push(bad.subarray(4))).toThrow(/unsupported protocol version/);
    expect(decoder.pendingBytes).toBe(bad.length);
    // Still stuck: the bad frame never left the buffer.
    expect(() => decoder.push(new Uint8Array(0))).toThrow(/unsupported protocol version/);

    decoder.reset();
    expect(decoder.pendingBytes).toBe(0);
    expect(decoder.push(encodeMessage({ n: 2 })).map((f) => f.value)).toEqual([{ n: 2 }]);
  });

  // Per AGENTS.md's dispose rule this helper owns no timer, no listener and no
  // handle — only bytes — so `dispose()` is a state reset, not a cancellation.
  // It is also not terminal: a `using` block that disposes early must not leave
  // an object that throws on the next `push`.
  it('disposes as a state reset and stays usable afterwards', () => {
    const decoder = dec();
    const frame = encodeMessage({ n: 1 });
    decoder.push(frame.subarray(0, 6));
    expect(decoder.pendingBytes).toBe(6);

    decoder.dispose();
    expect(decoder.pendingBytes).toBe(0);
    // The half-header is gone, so the *whole* frame is now a complete frame
    // rather than a frame appended to a partial one. A reset drops buffered
    // bytes; it cannot complete them.
    expect(decoder.push(frame).map((f) => f.value)).toEqual([{ n: 1 }]);

    const fresh = dec();
    fresh.push(frame.subarray(0, 6));
    expect(typeof fresh[Symbol.dispose]).toBe('function');
    fresh[Symbol.dispose]();
    expect(fresh.pendingBytes).toBe(0);
  });
});
