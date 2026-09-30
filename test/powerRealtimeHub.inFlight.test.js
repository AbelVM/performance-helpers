/**
 * RT-007: sends to one subscriber overlapped, so frames could arrive out of order.
 *
 * `_drain` and `_flushAll` iterated every subscriber and called
 * `_flushSubscriber` whenever the queue was non-empty, **without consulting
 * `sub.inFlight`**. A subscriber with a send still awaiting the transport would
 * therefore be sent a *second* frame, and the two could reach the transport in
 * either order — while `stats().list` reported an `inFlight` number that gated
 * nothing.
 *
 * The guide says the hub gives every subscription a bounded queue, and documents
 * `batch: false` as being for "transports that cannot take several frames at
 * once". Both promises are about *one frame at a time per subscriber*, which is
 * what the gate delivers.
 *
 * The two drain paths needed **different** fixes, and that is the part worth
 * recording. `_drain` can simply skip a busy subscriber, because
 * `_flushSubscriber`'s own completion re-drains when work arrived meanwhile.
 * `_flushAll` cannot: `flush()` promises "resolves once all subscribers have been
 * drained", so skipping a busy subscriber would return with that subscriber's
 * queue undelivered — precisely the case `batch: false` exists to serve. So
 * `flush()` waits the outstanding send out instead, and the follow-up flush is
 * *returned* from the completion chain rather than fired and forgotten, so one
 * await covers the whole tail.
 *
 * Ordering and counts throughout. The transport here is a promise that settles on
 * a timer, and every assertion is a sequence or a counter — never a duration.
 */
import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';

/**
 * A hub whose transport records when each send starts and settles, and settles on
 * a timer so a second send *could* overlap if the code allowed it.
 *
 * `auto` leaves batching **on** (the default), which is what makes `_drain` run on
 * its own. Every test here originally used `batch: false`, where automatic
 * flushing is disabled and the caller drives everything through `flush()` — so
 * `_drain` was never executed, and removing its gate entirely left all six tests
 * green. One of the two paths the row names was untested.
 *
 * @param {{deliverAfterMs?: number, auto?: boolean}} [opts]
 */
function makeHub({ deliverAfterMs = 5, auto = false } = {}) {
  /** @type {string[]} */
  const events = [];
  let maxInFlight = 0;
  const hub = new PowerRealtimeHub({
    send: (sub) => {
      maxInFlight = Math.max(maxInFlight, sub.inFlight);
      events.push('start');
      return new Promise((resolve) =>
        setTimeout(() => {
          events.push('end');
          resolve();
        }, deliverAfterMs)
      );
    },
    // `batch: auto`, not `!auto`: `this._batch = batch !== false`, so passing
    // `true` enables the automatic drain and `false` disables it. The first
    // version used `!auto`, which turned batching **on** for the tests that meant
    // it off and off for the tests that meant it on.
    batch: auto,
  });
  return { hub, events, max: () => maxInFlight };
}

describe('RT-007: the automatic drain is gated too', () => {
  // The half of the row that `batch: false` cannot reach. With batching on, each
  // `publish` schedules a drain on the microtask, so publishing several messages
  // asks for several drains while earlier sends are still awaiting the
  // transport — exactly the overlap `_drain` must refuse. No `flush()` is called
  // anywhere in this block.
  it('refuses to start a second send while one is outstanding', async () => {
    // The arrangement is the whole test. `_scheduleFlush` early-returns while a
    // flush is already scheduled, so publishing five messages in one turn
    // produces **one** drain, not five — and with nothing in flight at that
    // point, the gate is never consulted. That is why the first version of this
    // test passed with the gate deleted: it never arranged the situation the gate
    // exists for. It has to publish, let the drain run and the send start, and
    // *then* publish again.
    const { hub, max } = makeHub({ auto: true });
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });

    hub.publish('t', 0);
    // A macrotask turn: the microtask drain has run, and the send is awaiting
    // the transport, so `inFlight` is 1.
    await new Promise((resolve) => setTimeout(resolve, 1));
    // Now ask for another drain while that send is outstanding.
    for (let i = 1; i < 5; i += 1) hub.publish('t', i);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(max()).toBe(1);
    hub.dispose();
  });

  it('serialises sends with no flush() call at all', async () => {
    const { hub, events } = makeHub({ auto: true });
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });

    hub.publish('t', 0);
    await new Promise((resolve) => setTimeout(resolve, 1));
    for (let i = 1; i < 4; i += 1) hub.publish('t', i);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(events.length).toBe(8);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i], `overlap at index ${i}: ${events.join(' ')}`).toBe('start');
    }
    hub.dispose();
  });

  it('still delivers every message on the automatic path', async () => {
    const { hub } = makeHub({ auto: true });
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m), { maxQueue: 50, maxBatch: 1 });
    hub.publish('t', 0);
    await new Promise((resolve) => setTimeout(resolve, 1));
    for (let i = 1; i < 4; i += 1) hub.publish('t', i);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(seen).toHaveLength(4);
    hub.dispose();
  });
});

describe('RT-007: one frame in flight per subscriber', () => {
  it('never has two sends outstanding for the same subscriber', async () => {
    // The defect. Before the gate this read 2 with a slow transport, and the
    // frames could reach the transport in either order.
    const { hub, max } = makeHub();
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });
    for (let i = 0; i < 5; i += 1) hub.publish('t', i);
    await hub.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(max()).toBe(1);
    hub.dispose();
  });

  it('serialises the sends: every start is followed by an end', async () => {
    // The ordering property, as a sequence. `start start` anywhere in the trace
    // is an overlap; this asserts the whole trace alternates.
    const { hub, events } = makeHub();
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });
    for (let i = 0; i < 5; i += 1) hub.publish('t', i);
    await hub.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(events.length).toBe(10); // five frames, each started and ended
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i], `overlap at index ${i}: ${events.join(' ')}`).toBe('start');
      expect(events[i + 1], `overlap at index ${i}: ${events.join(' ')}`).toBe('end');
    }
    hub.dispose();
  });

  it('still delivers every message', async () => {
    // The counterpart, and the reason the first two are not a fix by
    // suppression: serialising must not drop work.
    const { hub } = makeHub();
    const seen = [];
    hub.subscribe('t', (m) => seen.push(m), { maxQueue: 50, maxBatch: 1 });
    for (let i = 0; i < 5; i += 1) hub.publish('t', i);
    await hub.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(seen).toHaveLength(5);
    hub.dispose();
  });

  it('flush() waits out an in-flight send rather than skipping the subscriber', async () => {
    // The case the guide names: `batch: false` "is useful ... for transports that
    // cannot take several frames at once". A subscriber busy from a *previous*
    // flush must still be drained by the next `flush()`, or `flush()` resolves
    // with its queue undelivered — which is the documented guarantee.
    const { hub, events } = makeHub();
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });

    // `batch: false` disables automatic flushing, so the caller drives it — the
    // arrangement has to put a send *in flight* at the moment `flush()` is
    // called, which means starting one flush and not awaiting it. The first
    // version of this test published more work *after* awaiting the second flush,
    // so that flush had already finished and the later messages legitimately
    // waited for the next one — a wrong premise, and it under-counted the sends
    // rather than failing for the right reason.
    hub.publish('t', 'first');
    const inFlight = hub.flush();
    void inFlight;

    // Queued while the first send is still awaiting the transport.
    for (let i = 0; i < 3; i += 1) hub.publish('t', `more-${i}`);

    // This flush must **wait** the outstanding send out and then deliver the
    // three, rather than skipping the subscriber and resolving.
    const waiter = hub.flush();
    // **Awaiting only `waiter`**, and checking immediately. Awaiting both flushes
    // — as the first version did — waits the *first* flush's chain too, and that
    // chain delivers the three messages on its own, so the count came out the same
    // whether `flush()` waited or skipped. The property under test is that
    // `flush()` itself does not resolve before the work is out, so the only
    // honest observation is what has happened the moment it resolves.
    await waiter;

    // Four sends — 'first' plus three 'more-*' — each started and ended.
    expect(events.length).toBe(8);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i], `overlap at index ${i}: ${events.join(' ')}`).toBe('start');
    }
    hub.dispose();
  });

  it('leaves inFlight back at zero once everything settles', async () => {
    // The counter has to be usable, and a gate that only ever incremented would
    // make every later drain skip the subscriber forever.
    const { hub } = makeHub();
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });
    for (let i = 0; i < 3; i += 1) hub.publish('t', i);
    await hub.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(hub.stats().list[0].inFlight).toBe(0);
    // And a subscriber that has settled accepts work again.
    hub.publish('t', 'later');
    await hub.flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hub.stats().list[0].inFlight).toBe(0);
    hub.dispose();
  });

  it('a transport that rejects does not leave the subscriber stuck', async () => {
    // The gate is `inFlight > 0`, so a send that never decrements it would wedge
    // the subscriber permanently. A rejecting transport is the cheapest way to
    // check the error path decrements.
    /** @type {string[]} */
    const events = [];
    const hub = new PowerRealtimeHub({
      send: () => {
        events.push('start');
        return Promise.reject(new Error('transport refused'));
      },
      batch: false,
      onError() {
        events.push('error');
      },
    });
    hub.subscribe('t', () => {}, { maxQueue: 50, maxBatch: 1 });
    hub.publish('t', 'a');
    await hub.flush();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(hub.stats().list[0].inFlight).toBe(0);
    expect(events).toContain('error');
    hub.dispose();
  });
});
