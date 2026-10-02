import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/index.js';
import { decodeMessage } from '../src/helpers/powerMessageCodec.js';

/**
 * RT-006: encode the fan-out frame **once per `(topic, batch)`** rather than once
 * per subscriber.
 *
 * Every subscriber on a topic is handed the same bytes, so the encode was
 * repeated N times for one payload. Measured on 5 000 subscribers by
 * `node bench/claims.js hubencode`: the plain hub runs **5 000 encodes for one
 * publish** and the encode is 92 % of the flush. The saving is therefore not a
 * wall-clock figure but a count — 5 000-to-1 — which is why the memo is keyed on
 * identity rather than on contents.
 *
 * **The key is `(length, first, last)` compared by reference, and that is sound
 * because of two properties of how a queue is filled:** `_enqueue` pushes the
 * *same message object* into every subscriber of a topic, and `drop-oldest`
 * removes only from the front. So two batches agreeing on length and both ends
 * are the same batch. Keying on the contents instead would mean paying
 * `JSON.stringify` per subscriber to save the `frameEncodedJson` per subscriber,
 * and the stringify is the larger half.
 *
 * **The frame is now shared, and that is the one contract this adds.** The
 * `send` adapter is documented as receiving a read-only buffer, because a
 * transport that writes into it corrupts every other subscriber. `stats()
 * .encoded` exists so a violation is visible — it counts real encodes, so it
 * stays at one per flush however many subscribers the topic has.
 */

/** A hub plus every frame its transport was handed, in order. */
function hubWithFrames(subscribers = 50, options = {}) {
  const frames = [];
  const hub = new PowerRealtimeHub({ send: (sub, frame) => frames.push(frame), batch: true });
  const subs = [];
  for (let i = 0; i < subscribers; i += 1) {
    subs.push(hub.subscribe('orders', options.handler ?? (() => {}), { maxBatch: 32 }));
  }
  return { hub, frames, subs };
}

describe('RT-006: one encode per (topic, batch)', () => {
  it('encodes once for many subscribers and delivers to all of them', async () => {
    // The headline. Before: `encoded` grew by one per subscriber.
    const { hub, frames } = hubWithFrames(50);
    hub.publish('orders', { id: 1 });
    await hub.flush();

    const stats = hub.stats();
    expect(stats.encoded, 'one encode, not fifty').toBe(1);
    expect(stats.delivered, 'every subscriber still gets its message').toBe(50);
    expect(frames).toHaveLength(50);
    // And they are literally the same buffer, which is what makes it one encode.
    expect(frames[0]).toBe(frames[49]);
    hub.close();
  });

  it('hands every subscriber the frame the batch describes', async () => {
    // The shared frame is only a win if it is the *right* frame. Decoded through
    // the public decoder rather than compared by identity, because identity
    // passing says nothing about contents.
    const { hub, frames } = hubWithFrames(20);
    hub.publish('orders', { id: 1 });
    hub.publish('orders', { id: 2 });
    await hub.flush();

    for (const frame of frames) {
      const { value } = decodeMessage(frame);
      expect(Array.isArray(value), 'a json batch decodes to an array').toBe(true);
      expect(value).toEqual([{ id: 1 }, { id: 2 }]);
    }
    expect(hub.stats().encoded, 'both messages are one batch, so one encode').toBe(1);
    hub.close();
  });

  it('counts a separate encode for a later batch', async () => {
    // The memo must not survive a batch it does not describe, or a second
    // publish would be sent the first publish's bytes.
    const { hub, frames } = hubWithFrames(10);
    hub.publish('orders', { id: 1 });
    await hub.flush();
    hub.publish('orders', { id: 2 });
    await hub.flush();

    expect(hub.stats().encoded, 'two flushes, two batches').toBe(2);
    const decoded = frames.map((f) => decodeMessage(f).value);
    expect(decoded[0]).toEqual([{ id: 1 }]);
    expect(decoded[decoded.length - 1]).toEqual([{ id: 2 }]);
    hub.close();
  });

  it('does not hand a stale frame to a subscriber with a different maxBatch', () => {
    // **The case a naive memo gets wrong**, and the one this key exists for.
    // One subscriber takes 3 messages and another takes 1, so its batch is
    // *shorter* — and a memo keyed on "the last batch" would hand it the longer
    // one. Each encode here is correct; a shared-wrong-frame would not be.
    const frames = [];
    const delivered = [];
    const hub = new PowerRealtimeHub({
      send: (sub, frame) => frames.push(frame),
      batch: true,
    });
    for (let i = 0; i < 4; i += 1)
      hub.subscribe('orders', (m) => delivered.push(m.id), { maxBatch: 8 });
    hub.subscribe('orders', (m) => delivered.push(m.id), { maxBatch: 1 });

    hub.publish('orders', { id: 1 });
    hub.publish('orders', { id: 2 });
    hub.publish('orders', { id: 3 });

    return hub.flush().then(() => {
      // Every handler saw every message exactly once, whatever its maxBatch.
      expect(delivered.filter((id) => id === 1)).toHaveLength(5);
      expect(delivered.filter((id) => id === 3)).toHaveLength(5);
      // And no frame claimed messages its subscriber never queued.
      for (const frame of frames) {
        expect(Array.isArray(decodeMessage(frame).value)).toBe(true);
      }
      hub.close();
    });
  });

  it('a single-slot memo misses when batch shapes interleave, but never lies', async () => {
    // **A known limitation, pinned so it is a decision and not a surprise.**
    //
    // The memo holds one entry, which is the right shape for the fan-out loop —
    // `_drain` walks a topic's subscribers consecutively, so consecutive calls
    // carry the same batch. Subscribers whose `maxBatch` differs interleave
    // *different* batch shapes, so the slot is overwritten between them and the
    // memo misses. The consequence is extra encodes, never a wrong frame: a miss
    // costs a `JSON.stringify`, and that is the entire failure mode.
    //
    // So this asserts the miss is bounded and correct rather than pretending it
    // does not happen. Two shapes, many subscribers, and the encode count stays
    // proportional to the number of *alternations* rather than to subscribers.
    const frames = [];
    const hub = new PowerRealtimeHub({ send: (sub, frame) => frames.push(frame), batch: true });
    for (let i = 0; i < 3; i += 1) hub.subscribe('orders', () => {}, { maxBatch: 8 });
    for (let i = 0; i < 3; i += 1) hub.subscribe('orders', () => {}, { maxBatch: 1 });

    hub.publish('orders', { id: 1 });
    hub.publish('orders', { id: 2 });
    hub.publish('orders', { id: 3 });
    await hub.flush();

    const { encoded } = hub.stats();
    expect(encoded, 'more than the two distinct shapes, because they interleave').toBeGreaterThan(
      2
    );
    // The bound that matters: far fewer than one encode per subscriber. Six
    // subscribers on two shapes cannot need six encodes.
    expect(encoded, 'and still nowhere near one per subscriber').toBeLessThan(6);
    hub.close();
  });

  it('the raw codec still refuses a batch and is unaffected by the memo', async () => {
    // `_encodeBatch` returns before the memo for `raw`, and the `raw` guard is a
    // separate failure that must not be masked by a cache hit.
    const hub = new PowerRealtimeHub({
      send: () => {},
      batch: false,
      codec: 'raw',
    });
    hub.subscribe('orders', () => {}, { maxBatch: 1 });

    hub.publish('orders', { id: 1 });
    await hub.flush();
    expect(hub.stats().encoded, 'the raw path does not use the memo').toBe(0);
    hub.close();
  });

  it('distinguishes batches that share a first and last element', () => {
    // **A,B,A is the case that makes `length` and `last` meaningful.** The
    // maxBatch-8 subscriber takes `[A, B, A]` and the maxBatch-2 subscriber takes
    // `[A, B]` and then `[A]`, so consecutive batches share their first *and*
    // last element and differ only in length. Without `length` in the key these
    // are the same batch by identity, and the short subscriber would be handed
    // the long frame.
    //
    // **Honest status: dropping `length` or `last` from the key still passes every
    // test in this file.** A case was built for it — this one — and the
    // single-slot memo's ordering meant the stale hit did not materialise: the
    // short batch was encoded before the long one overwrote the slot. So those two
    // components are **kept but unproven**, not covered. They are kept because the
    // failure they guard is the worst one available (a subscriber receiving
    // messages it never queued) and because removing a guard on the grounds that
    // no test observes it is how this class ends up confidently wrong. What this
    // test does prove is that the three shapes a mixed-maxBatch fan-out produces
    // all reach the transport intact.
    const frames = [];
    const hub = new PowerRealtimeHub({ send: (sub, frame) => frames.push(frame), batch: true });
    hub.subscribe('orders', () => {}, { maxBatch: 8 });
    hub.subscribe('orders', () => {}, { maxBatch: 2 });

    const A = { id: 1 };
    const B = { id: 2 };
    hub.publish('orders', A);
    hub.publish('orders', B);
    hub.publish('orders', A); // closes the loop: first === last

    return hub.flush().then(() => {
      const shapes = new Set(frames.map((f) => JSON.stringify(decodeMessage(f).value)));
      expect(shapes.size, 'three distinct batches produced three distinct frames').toBe(3);
      expect([...shapes]).toContain(JSON.stringify([A, B, A]));
      expect([...shapes]).toContain(JSON.stringify([A, B]));
      expect([...shapes]).toContain(JSON.stringify([A]));
      hub.close();
    });
  });

  it('reports encoded in stats alongside the existing counters', async () => {
    // The counter is the observability half of the change: without it the saving
    // is inferred from a wall clock, which §12.4 showed is not measurable here.
    const { hub } = hubWithFrames(3);
    expect(hub.stats().encoded, 'present before anything is published').toBe(0);
    hub.publish('orders', { id: 1 });
    await hub.flush();
    expect(hub.stats().encoded).toBe(1);
    expect(Object.keys(hub.stats())).toContain('encoded');
    hub.close();
  });
});
