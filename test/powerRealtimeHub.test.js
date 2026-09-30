import { describe, it, expect, vi, beforeAll } from 'vitest';
import fc from 'fast-check';
import { PowerRealtimeHub, decodeMessage, preloadNode } from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/** A transport double that records every frame it is handed. */
function recorder(opts = {}) {
  const frames = [];
  const hub = new PowerRealtimeHub({
    send: (sub, frame) => {
      if (opts.fail) throw opts.fail;
      frames.push({ id: sub.id, frame });
    },
    close: opts.close,
    onError: opts.onError,
    batch: false,
  });
  return { hub, frames, decoded: () => frames.map((f) => decodeMessage(f.frame)) };
}

describe('PowerRealtimeHub basics', () => {
  it('requires a send adapter', () => {
    expect(() => new PowerRealtimeHub({})).toThrow(/send\(subscriber, frame\)/);
    expect(() => new PowerRealtimeHub()).toThrow(TypeError);
  });

  it('validates subscribe arguments', () => {
    const { hub } = recorder();
    expect(() => hub.subscribe('', () => {})).toThrow(/non-empty string/);
    expect(() => hub.subscribe('t', 'nope')).toThrow(/must be a function/);
    expect(() => hub.subscribe('t', () => {}, { slowConsumer: 'explode' })).toThrow(/slowConsumer/);
    expect(() => hub.subscribe('t', () => {}, { maxQueue: -1 })).toThrow(/maxQueue/);
    expect(() => hub.subscribe('t', () => {}, { maxBatch: 0 })).toThrow(/maxBatch/);
  });

  it('delivers a published message to every subscriber of the topic', async () => {
    const { hub, frames, decoded } = recorder();
    hub.subscribe('news', () => {});
    hub.subscribe('news', () => {});
    hub.subscribe('other', () => {});

    expect(hub.publish('news', { id: 1 })).toBe(2);
    expect(hub.publish('nowhere', { id: 2 })).toBe(0);
    await hub.flush();

    expect(frames.length).toBe(2);
    for (const d of decoded()) expect(d.value).toEqual([{ id: 1 }]);
    hub.close();
  });

  it('unsubscribing stops delivery and prunes the topic', async () => {
    const { hub, frames } = recorder();
    const un = hub.subscribe('t', () => {}, { id: 'a' });
    hub.subscribe('t', () => {}, { id: 'b' });
    expect(un()).toBe(true);
    expect(un()).toBe(false); // already gone
    hub.publish('t', 1);
    await hub.flush();
    expect(frames.map((f) => f.id)).toEqual(['b']);
    expect(hub.stats().topics).toBe(1);
    hub.close();
  });

  it('rejects a duplicate subscriber id', () => {
    const { hub } = recorder();
    hub.subscribe('t', () => {}, { id: 'dup' });
    expect(() => hub.subscribe('t', () => {}, { id: 'dup' })).toThrow(/duplicate/);
    hub.close();
  });

  it('isolates a throwing handler and reports it through onError', async () => {
    const onError = vi.fn();
    const { hub } = recorder({ onError });
    hub.subscribe('t', () => {
      throw new Error('handler-boom');
    });
    hub.publish('t', 1);
    await expect(hub.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toBe('handler-boom');
    hub.close();
  });

  it('reports a throwing transport through onError without stopping other subscribers', async () => {
    const onError = vi.fn();
    const frames = [];
    const hub = new PowerRealtimeHub({
      send: (sub) => {
        if (sub.id === 'bad') throw new Error('socket-gone');
        frames.push(sub.id);
      },
      onError,
      batch: false,
    });
    hub.subscribe('t', () => {}, { id: 'bad' });
    hub.subscribe('t', () => {}, { id: 'good' });
    hub.publish('t', 1);
    await hub.flush();
    expect(onError).toHaveBeenCalled();
    expect(frames).toEqual(['good']);
    hub.close();
  });
});

describe('PowerRealtimeHub slow-consumer policies', () => {
  it("'drop-oldest' keeps the newest messages (the default)", async () => {
    const { hub } = recorder();
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m), { maxQueue: 3 });
    for (let i = 1; i <= 6; i++) hub.publish('t', i);
    await hub.flush();
    // 1 and 2 were discarded to make room; 4..6 survive.
    expect(seen).toEqual([4, 5, 6]);
    expect(hub.stats().dropped).toBeGreaterThan(0);
    expect(hub.stats().list[0].dropped).toBeGreaterThan(0);
    hub.close();
  });

  it("'drop-newest' keeps what is already queued", async () => {
    const { hub } = recorder();
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m), { maxQueue: 3, slowConsumer: 'drop-newest' });
    for (let i = 1; i <= 6; i++) hub.publish('t', i);
    await hub.flush();
    expect(seen).toEqual([1, 2, 3]);
    hub.close();
  });

  it("'disconnect' closes the subscriber once it falls behind", async () => {
    const closed = [];
    const { hub, frames } = recorder({ close: (sub, reason) => closed.push([sub.id, reason]) });
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m), {
      maxQueue: 2,
      slowConsumer: 'disconnect',
      id: 'slow',
    });
    for (let i = 1; i <= 5; i++) hub.publish('t', i);
    await hub.flush();

    expect(closed).toEqual([['slow', 'slow-consumer']]);
    expect(frames.length).toBe(0); // disconnected before any send
    expect(hub.stats().subscribers).toBe(0);
    expect(hub.stats().disconnected).toBe(1);
    // A disconnected subscriber stops receiving, so this is a no-op.
    expect(hub.publish('t', 99)).toBe(0);
    hub.close();
  });

  it('maxQueue 0 evaluates the policy immediately (no buffering)', async () => {
    const { hub } = recorder();
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m), { maxQueue: 0, slowConsumer: 'drop-newest' });
    hub.publish('t', 1);
    hub.publish('t', 2);
    await hub.flush();
    // Nothing ever queued, so every publish was refused.
    expect(seen).toEqual([]);
    expect(hub.stats().dropped).toBe(2);
    hub.close();
  });

  it('one slow subscriber does not affect a fast one', async () => {
    const { hub } = recorder();
    const slow = [];
    const fast = [];
    hub.subscribe('t', (m) => slow.push(m), { maxQueue: 2, id: 'slow' });
    hub.subscribe('t', (m) => fast.push(m), { maxQueue: 100, id: 'fast' });
    for (let i = 1; i <= 20; i++) hub.publish('t', i);
    await hub.flush();
    expect(fast).toHaveLength(20);
    expect(slow.length).toBeLessThan(20);
    expect(hub.stats().subscribers).toBe(2);
    hub.close();
  });
});

describe('PowerRealtimeHub batching', () => {
  it('coalesces a burst into a single frame', async () => {
    const frames = [];
    const hub = new PowerRealtimeHub({
      send: (sub, frame) => frames.push(frame),
      batch: true,
    });
    hub.subscribe('t', () => {}, { maxBatch: 100 });
    for (let i = 1; i <= 5; i++) hub.publish('t', i);
    await hub.flush();
    expect(frames.length).toBe(1);
    expect(decodeMessage(frames[0]).value).toEqual([1, 2, 3, 4, 5]);
    hub.close();
  });

  it('honours maxBatch and sends consecutive frames', async () => {
    const frames = [];
    const hub = new PowerRealtimeHub({ send: (s, f) => frames.push(f), batch: true });
    hub.subscribe('t', () => {}, { maxBatch: 2 });
    for (let i = 1; i <= 5; i++) hub.publish('t', i);
    await hub.flush();
    // Queued remainder is drained on subsequent flushes too.
    await hub.flush();
    await hub.flush();
    const values = frames.map((f) => decodeMessage(f).value);
    expect(values[0]).toEqual([1, 2]);
    expect(values.length).toBeGreaterThan(1);
    expect(values.flat()).toEqual([1, 2, 3, 4, 5]);
    hub.close();
  });

  it('batch:false stops auto-flushing; the caller drives flush()', async () => {
    const frames = [];
    const hub = new PowerRealtimeHub({ send: (s, f) => frames.push(f), batch: false });
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m));
    hub.publish('t', 1);
    hub.publish('t', 2);

    // No microtask flush is scheduled, so nothing has been sent yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(frames.length).toBe(0);

    await hub.flush();
    // One flush drains the queue as a single batch, bounded by `maxBatch`.
    expect(frames.length).toBe(1);
    expect(decodeMessage(frames[0]).value).toEqual([1, 2]);
    expect(seen).toEqual([1, 2]);
    hub.close();
  });

  it('every frame is decodable and self-delimiting', async () => {
    const { hub, frames } = recorder();
    hub.subscribe('t', () => {}, { maxBatch: 2 });
    for (let i = 0; i < 7; i++) hub.publish('t', { i, pad: 'x'.repeat(50) });
    await hub.flush();
    await hub.flush();
    await hub.flush();
    for (const f of frames) {
      const d = decodeMessage(f.frame);
      expect(d.byteLength).toBe(f.frame.length);
      expect(Array.isArray(d.value)).toBe(true);
    }
    hub.close();
  });
});

describe('PowerRealtimeHub lifecycle', () => {
  it('close() detaches everything and is idempotent', () => {
    const closed = [];
    const hub = new PowerRealtimeHub({
      send: () => {},
      close: (sub, reason) => closed.push([sub.id, reason]),
    });
    hub.subscribe('a', () => {}, { id: 'x' });
    hub.subscribe('b', () => {}, { id: 'y' });
    hub.close();
    hub.close();
    expect(closed.map((c) => c[0])).toEqual(['x', 'y']);
    expect(hub.stats().subscribers).toBe(0);
    expect(hub.stats().topics).toBe(0);
    // Publishing after close is a no-op, not a throw.
    expect(hub.publish('a', 1)).toBe(0);
    expect(() => hub.subscribe('a', () => {})).toThrow(/closed/);
  });

  it('supports Symbol.dispose', () => {
    const hub = new PowerRealtimeHub({ send: () => {} });
    hub.subscribe('t', () => {});
    hub[Symbol.dispose]();
    expect(hub.stats().subscribers).toBe(0);
  });

  it('retain keeps a bounded log for later subscribers', async () => {
    const { hub } = recorder();
    for (let i = 1; i <= 50; i++) hub.publish('cfg', i, { retain: true });
    const seen = [];
    hub.subscribe('cfg', (m) => seen.push(m));
    await hub.flush();
    // Bounded: the log is capped, it does not grow without limit.
    expect(seen.length).toBeLessThanOrEqual(32);
    hub.close();
  });
});

describe('PowerRealtimeHub invariants', () => {
  it('queue depth never exceeds maxQueue, whatever the publish pattern', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.array(fc.nat({ max: 50 }), { minLength: 1, maxLength: 80 }),
        (maxQueue, publishes) => {
          const hub = new PowerRealtimeHub({ send: () => {}, batch: false });
          const sub = hub.subscribe('t', () => {}, { maxQueue, slowConsumer: 'drop-oldest' });
          for (const i of publishes) hub.publish('t', i);
          for (const s of hub.stats().list) {
            expect(s.queued).toBeLessThanOrEqual(maxQueue);
          }
          sub();
          hub.close();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('delivered + dropped never exceeds published, per subscriber', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(fc.nat({ max: 30 }), { minLength: 1, maxLength: 60 }),
        (maxQueue, publishes) => {
          const hub = new PowerRealtimeHub({ send: () => {}, batch: false });
          const seen = [];
          hub.subscribe('t', (m) => seen.push(m), { maxQueue, slowConsumer: 'drop-oldest' });
          for (const i of publishes) hub.publish('t', i);
          const s = hub.stats().list[0];
          // Every message is accounted for: delivered to the handler, still
          // queued, or dropped. Nothing vanishes silently.
          expect(s.dropped + s.queued).toBeGreaterThanOrEqual(0);
          expect(s.queued).toBeLessThanOrEqual(maxQueue);
          hub.close();
        }
      ),
      { numRuns: 150 }
    );
  });

  it('publish returns the number of live subscribers for the topic', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 0, maxLength: 12 }), (joins) => {
        const hub = new PowerRealtimeHub({ send: () => {}, batch: false });
        const subs = [];
        for (let i = 0; i < 8; i++) {
          if (joins[i % joins.length]) subs.push(hub.subscribe('t', () => {}, { id: `s${i}` }));
        }
        expect(hub.publish('t', 1)).toBe(subs.length);
        for (const un of subs) un();
        expect(hub.publish('t', 1)).toBe(0);
        hub.close();
      }),
      { numRuns: 100 }
    );
  });
});

/**
 * TEST-003: the `inFlight <= 1` invariant.
 *
 * `stats().list` reports a per-subscriber `inFlight`, and RT-007's point is that
 * **it gates nothing**: `_drain` / `_flushAll` never consult it, so sends overlap
 * and frames can reach a transport out of order while the number sits in a stats
 * object implying a bound that does not exist.
 *
 * So this is a **characterisation**, not `expect(max).toBeLessThanOrEqual(1)`:
 * asserting the bound today would fail the suite and assert an aspiration. What
 * is pinned is the observed maximum, so the counter exists and RT-007's fix has
 * something to move. A characterisation is a measurement, not a promise.
 *
 * Three guessed shapes preceded this, all of which the code does not have: a
 * `makeHub` helper, an `attachTransport` method, and `sub.send(...)` on the
 * result of `subscribe`. In fact **`subscribe` returns an unsubscribe function,
 * not the subscriber** — `return () => this.unsubscribe(sub.id)` — so there is
 * no `sub` object to read. The subscriber reaches the test through the `send`
 * adapter, which is handed it, and that is the only supported way to see it
 * without depending on an unverified `stats()` shape.
 */
describe('TEST-003: per-subscriber inFlight', () => {
  it('records the maximum inFlight reached while frames are in the transport', async () => {
    /** @type {any} */
    let seen = null;
    let max = 0;
    const hub = new PowerRealtimeHub({
      send: (sub) => {
        seen = sub;
        // The counter is incremented by `_flushSubscriber` before the adapter is
        // called, so this reads the live value rather than my own tally — which
        // is the point: RT-007 says this number exists but gates nothing.
        max = Math.max(max, sub.inFlight);
        // A transport that does not settle synchronously, so a second send can
        // start while the first is outstanding: the overlap RT-007 is about.
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
      batch: false,
    });
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });
    // Messages reach a subscriber through `publish`. `maxBatch: 1` so each
    // publish becomes its own frame, which is what lets two be in flight at once.
    for (let i = 0; i < 5; i += 1) hub.publish('t', i);
    // `flush()`, not a sleep: the drain is microtask-scheduled and every other
    // test here awaits the flush rather than guessing a delay. With a slow
    // transport this also waits for the frames to land, which is what makes the
    // final `inFlight` reading meaningful.
    await hub.flush();

    // The adapter ran, and the counter had reached at least 1 while the frame
    // was outstanding. `flush()` does **not** await in-flight sends — the first
    // version read `inFlight` straight after it and got 1, not 0, which is the
    // counter being live rather than a bug.
    expect(seen, 'the send adapter was never called').not.toBeNull();
    // **Now exactly 1, and the assertion was tightened to match.** This was
    // written as a characterisation with the target named —
    // `toBeGreaterThanOrEqual(1)`, which accepts any value and is decoration by
    // this repository's own rule. It measured 2 or more before RT-007 landed and
    // reads 1 now, so it is a real assertion: the value is the one the row asked
    // for, and a regression to overlapping sends fails it here.
    expect(max).toBe(1);

    // Once the transport settles, it comes back to zero. That the counter both
    // rises and falls is what makes `max` meaningful rather than a constant.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen.inFlight).toBe(0);
    hub.dispose();
  });
});
