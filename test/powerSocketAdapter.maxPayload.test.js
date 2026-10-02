import { describe, it, expect } from 'vitest';
import { PowerSocketAdapter } from '../src/index.js';

/**
 * RT-009 — `maxPayloadSizeBytes` on the **server-side** helper, the row's second
 * half. The client's half is covered by `powerWebSocketClient.maxPayload.test.js`
 * and its option was already shipped when this row was picked up; what was
 * missing was the adapter and any documentation of either.
 *
 * **Detection, not prevention, again.** By the time any transport delivers a
 * frame the platform has already received and materialised it, so this option
 * reports an oversized frame and lets it through. The counter answers "what
 * arrived", so the check is deliberately placed *before* the drain and
 * rate-limit filters — see the two tests that pin that ordering, because it is
 * the part a future refactor would move and the part that makes the number mean
 * something.
 *
 * **These tests drive `_handleMessage` directly** rather than a fake socket, for
 * the reason the client's file gives: a fake socket here would be a second,
 * weaker copy of transport coverage that already exists, and one that never
 * completes its open handshake would make every case below pass vacuously. The
 * cache and queue tests here already reach into privates, so this is the
 * smaller risk.
 */

/** A minimal `ws`-shaped socket: `.on` plus `.send`, which is what detection needs. */
function fakeSocket() {
  return { on() {}, send() {}, readyState: 1, close() {}, terminate() {} };
}

/**
 * An adapter with the detection wired, plus error and message taps.
 * @param {object} [options]
 */
function adapter(options = {}) {
  const errors = [];
  const messages = [];
  const a = new PowerSocketAdapter(fakeSocket(), {
    onError: (e) => errors.push(e),
    onMessage: (m) => messages.push(m),
    ...options,
  });
  return { a, errors, messages };
}

/** A binary frame of `bytes` length, the shape a size limit exists for. */
const frameOf = (bytes) => new Uint8Array(bytes);

describe('RT-009: PowerSocketAdapter maxPayloadSizeBytes reports an oversized frame without stopping it', () => {
  it('reports a frame over the limit and still delivers it', () => {
    // **Both halves, and both matter.** The report is the feature; the delivery
    // is what makes it *detection*. A version that dropped the frame would pass a
    // counter-only test and quietly become prevention, which is the specific
    // misrepresentation this row exists to prevent.
    const { a, errors, messages } = adapter({ maxPayloadSizeBytes: 100 });
    a._handleMessage(frameOf(500), true);

    expect(a.stats().oversizeFrames).toBe(1);
    expect(errors, 'the peer is told what arrived').toHaveLength(1);
    expect(messages, 'and the frame is not dropped').toHaveLength(1);
    expect(messages[0].data.byteLength).toBe(500);

    a.dispose();
  });

  it('says plainly that this is detection and not prevention', () => {
    // **The message is the contract.** RT-009's whole argument is that a limit
    // which sounds like a limit and is not one is worse than no limit. So the
    // three phrases that carry that distinction are asserted directly rather than
    // trusted to the factory's docblock — a rewrite that softened them would
    // restore a promise the option cannot keep, and this fails instead.
    const { a, errors } = adapter({ maxPayloadSizeBytes: 10 });
    a._handleMessage(frameOf(100), true);

    const { message } = errors[0];
    expect(message).toMatch(/detection, not prevention/);
    expect(message).toMatch(/already received and buffered/);
    expect(message).toMatch(/Bound the payload at the peer that produces it/);

    a.dispose();
  });

  it('names PowerSocketAdapter in the message, so a two-direction app can tell them apart', () => {
    // One `onError` handler serving both helpers is the reason the client and the
    // adapter share a factory, and a shared factory is only useful if the message
    // says which helper reported. Without the class name the two are
    // indistinguishable at the one place a user would look.
    const { a, errors } = adapter({ maxPayloadSizeBytes: 10 });
    a._handleMessage(frameOf(100), true);

    expect(errors[0].message).toMatch(/^PowerSocketAdapter: received a 100-byte frame/);

    a.dispose();
  });

  it('carries a stable code and both figures, so a caller does not parse text', () => {
    // The reason this lives in `utils/errors.js` beside `queueFullError` rather
    // than staying a bare `new Error`: one condition, one shape, written once.
    const { a, errors } = adapter({ maxPayloadSizeBytes: 10 });
    a._handleMessage(frameOf(42), true);

    expect(errors[0].code).toBe('ERR_FRAME_TOO_LARGE');
    expect(errors[0].size).toBe(42);
    expect(errors[0].limit).toBe(10);

    a.dispose();
  });

  it('reports nothing for a frame under the limit', () => {
    const { a, errors, messages } = adapter({ maxPayloadSizeBytes: 1000 });
    a._handleMessage(frameOf(100), true);

    expect(a.stats().oversizeFrames).toBe(0);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);

    a.dispose();
  });

  it('treats the limit as inclusive, so exactly-at-the-limit is not over it', () => {
    const { a } = adapter({ maxPayloadSizeBytes: 100 });
    a._handleMessage(frameOf(100), true);
    expect(a.stats().oversizeFrames, 'exactly at the limit is not over it').toBe(0);

    a._handleMessage(frameOf(101), true);
    expect(a.stats().oversizeFrames).toBe(1);

    a.dispose();
  });

  it('defaults to Infinity, which disables the report', () => {
    const { a, errors, messages } = adapter({});
    a._handleMessage(frameOf(1_000_000), true);

    expect(a.stats().oversizeFrames).toBe(0);
    expect(errors).toHaveLength(0);
    expect(messages, 'the frame still arrives').toHaveLength(1);

    a.dispose();
  });

  it('treats 0 as "no check" rather than "report everything"', () => {
    // The client's first draft took `min: 0` as "accepted" and documented it as
    // "no check", which is the opposite of what `size > 0` does for every
    // non-empty frame — so `0` meant *report everything*. The convention is
    // pinned here on both helpers rather than only where the bug was found.
    const { a, errors, messages } = adapter({ maxPayloadSizeBytes: 0 });
    a._handleMessage(frameOf(500), true);

    expect(a.stats().oversizeFrames).toBe(0);
    expect(errors).toHaveLength(0);
    expect(messages).toHaveLength(1);

    a.dispose();
  });

  it('counts an oversized frame that the rate limit then refuses', () => {
    // **The ordering this row's placement encodes.** `oversizeFrames` answers
    // "what arrived"; `rateLimited` answers "what was admitted". An oversized
    // frame that the limiter drops is *both*, and folding it into the limiter's
    // counter would hide the peer sending 40 MB frames — the exact fact the
    // option exists to make alertable. If a future change moves this check below
    // the limiter, this fails.
    const { a, errors } = adapter({
      maxPayloadSizeBytes: 10,
      rateLimit: { limit: 1, windowMs: 60_000 },
    });
    a._handleMessage(frameOf(500), true); // oversized, and the first through the limiter
    a._handleMessage(frameOf(500), true); // oversized, and refused by the limiter

    expect(a.stats().oversizeFrames).toBe(2, 'both frames arrived oversized');
    expect(a.stats().rateLimited).toBe(1);
    expect(errors).toHaveLength(2);

    a.dispose();
  });

  it('counts an oversized frame that arrives while draining', () => {
    // Same argument as the rate-limit case, and the reason the check sits above
    // the drain branch too. `drainedFromDrain` already counts it as a dropped
    // message; a drain is a shutdown you asked for, not evidence about the peer.
    const { a } = adapter({ maxPayloadSizeBytes: 10 });
    a._draining = true;
    a._handleMessage(frameOf(500), true);

    expect(a.stats().oversizeFrames).toBe(1);
    expect(a.stats().drainedFromDrain).toBe(1);

    a.dispose();
  });

  it('rejects an unknown option, so a typo is not silently ignored', () => {
    // The reason `maxPayloadSizeBytes` was added to `assertKnownOptions` rather
    // than only read from `options`. Without it, `maxPayloadSize: 100` would
    // configure nothing and report a clean `oversizeFrames: 0` forever — the
    // "a limit that sounds like a limit and is not" failure, one level up.
    expect(() => adapter({ maxPayloadSixeBytes: 100 })).toThrow(/maxPayloadSixeBytes/);

    const { a } = adapter({ maxPayloadSizeBytes: 100 });
    a.dispose();
  });
});
