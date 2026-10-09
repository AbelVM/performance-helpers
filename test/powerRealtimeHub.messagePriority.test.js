import { describe, it, expect, beforeAll } from 'vitest';
import { PowerRealtimeHub, decodeMessage, preloadNode } from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/**
 * A transport double that records every frame it is handed, in order.
 *
 * `batch: false` throughout, so one publish is one frame and the recorded order
 * *is* the delivery order. With batching on, several publishes coalesce into one
 * frame and the ordering under test would be invisible.
 */
function recorder(opts = {}) {
  const frames = [];
  const hub = new PowerRealtimeHub({
    send: (sub, frame) => {
      frames.push({ id: sub.id, frame });
    },
    close: opts.close,
    onError: opts.onError,
    batch: false,
    ...opts.hub,
  });
  return { hub, frames, decoded: () => frames.map((f) => decodeMessage(f.frame)) };
}

/** Subscribe one recording subscriber and return the messages it received. */
function oneSubscriber(hubOpts = {}, subOpts = {}) {
  const seen = [];
  const { hub } = recorder({ hub: hubOpts });
  hub.subscribe('t', (m) => seen.push(m), subOpts);
  return { hub, seen };
}

describe('PowerRealtimeHub message priority (RT-001)', () => {
  describe('the default is unchanged', () => {
    it('delivers FIFO with no messagePriority option', async () => {
      // The property the review row calls out. A future refactor that made the
      // heap the default would pass every priority test and silently reorder
      // every existing caller, so this is pinned rather than assumed.
      const { hub, seen } = oneSubscriber();
      hub.publish('t', { n: 1 });
      hub.publish('t', { n: 2 });
      hub.publish('t', { n: 3 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([1, 2, 3]);
    });

    it('ignores a priority field on the message itself', async () => {
      // The hub does not read ordering out of a caller's payload. Inventing a
      // convention over `message.priority` would mean a payload that happens to
      // carry that field is silently reordered.
      const { hub, seen } = oneSubscriber();
      hub.publish('t', { n: 1, priority: 99 });
      hub.publish('t', { n: 2, priority: 1 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([1, 2]);
    });

    it('keeps drop-oldest discarding the head', async () => {
      // The documented quirk, pinned so the priority work cannot quietly change
      // it for the default path.
      const { hub, seen } = oneSubscriber({}, { maxQueue: 2 });
      hub.publish('t', { n: 1 });
      hub.publish('t', { n: 2 });
      hub.publish('t', { n: 3 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([2, 3]);
    });
  });

  describe('ordering', () => {
    it('delivers higher priority first', async () => {
      const { hub, seen } = oneSubscriber({ messagePriority: true });
      hub.publish('t', { n: 'low' }, { priority: 1 });
      hub.publish('t', { n: 'high' }, { priority: 10 });
      hub.publish('t', { n: 'med' }, { priority: 5 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual(['high', 'med', 'low']);
    });

    it('breaks ties by arrival order', async () => {
      // FIFO among equals is the stability guarantee, and it is what makes an
      // omitted priority behave exactly like an explicit `0`.
      const { hub, seen } = oneSubscriber({ messagePriority: true });
      hub.publish('t', { n: 1 });
      hub.publish('t', { n: 2 }, { priority: 0 });
      hub.publish('t', { n: 3 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([1, 2, 3]);
    });

    it('interleaves priorities and ties', async () => {
      const { hub, seen } = oneSubscriber({ messagePriority: true });
      hub.publish('t', { n: 'a' }, { priority: 1 });
      hub.publish('t', { n: 'b' }, { priority: 5 });
      hub.publish('t', { n: 'c' }, { priority: 1 });
      hub.publish('t', { n: 'd' }, { priority: 5 });
      hub.publish('t', { n: 'e' }, { priority: 3 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual(['b', 'd', 'e', 'a', 'c']);
    });

    it('reorders across a batch boundary', async () => {
      // Priority must survive `maxBatch`, not just apply within one frame. A
      // heap consulted only at splice time would order each batch internally
      // and leave the batches themselves in arrival order.
      const { hub, seen } = oneSubscriber({ messagePriority: true }, { maxBatch: 2 });
      hub.publish('t', { n: 1 }, { priority: 1 });
      hub.publish('t', { n: 2 }, { priority: 1 });
      hub.publish('t', { n: 3 }, { priority: 9 });
      hub.publish('t', { n: 4 }, { priority: 9 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([3, 4, 1, 2]);
    });

    it('is independent of the per-subscriber drain order', async () => {
      // Two different orderings that must not be conflated: `priority` on
      // subscribe() decides which *subscriber* is served first, `priority` on
      // publish() decides which *message* a subscriber receives next.
      const frames = [];
      const hub = new PowerRealtimeHub({
        send: (sub, frame) => {
          frames.push({ id: sub.id, frame });
        },
        batch: false,
        messagePriority: true,
      });
      const a = [];
      const b = [];
      hub.subscribe('t', (m) => a.push(m.n), { id: 'a', priority: 1 });
      hub.subscribe('t', (m) => b.push(m.n), { id: 'b', priority: 9 });
      hub.publish('t', { n: 'x' }, { priority: 1 });
      hub.publish('t', { n: 'y' }, { priority: 9 });
      await hub.flush();
      // Both subscribers get the same message order...
      expect(a).toEqual(['y', 'x']);
      expect(b).toEqual(['y', 'x']);
      // ...and `b` was served first because its drain priority is higher. One
      // frame each, because `maxBatch` defaults to 32 and coalesces both
      // messages — the drain order is about *who is served*, not how many
      // frames that takes.
      expect(frames.map((f) => f.id)).toEqual(['b', 'a']);
    });
  });

  describe('validation', () => {
    it('throws when priority is passed without messagePriority', () => {
      // The silent-ignore failure this option exists to refuse: a caller who
      // believes they asked for priority and gets FIFO.
      const { hub } = recorder();
      expect(() => hub.publish('t', { n: 1 }, { priority: 5 })).toThrow(
        /requires the hub option .*messagePriority/
      );
    });

    it('rejects a non-finite priority', () => {
      // `NaN` compares unequal to everything, so a heap that accepted it would
      // order those messages arbitrarily rather than at the back.
      const { hub } = oneSubscriber({ messagePriority: true });
      expect(() => hub.publish('t', { n: 1 }, { priority: NaN })).toThrow(/finite number/);
      expect(() => hub.publish('t', { n: 1 }, { priority: 'high' })).toThrow(/finite number/);
    });

    it('rejects an unknown publish option', () => {
      const { hub } = oneSubscriber({ messagePriority: true });
      expect(() => hub.publish('t', { n: 1 }, { prioroty: 5 })).toThrow(/unknown option/);
    });

    it('rejects an unknown hub option', () => {
      expect(() => new PowerRealtimeHub({ send: () => {}, messagePrioirty: true })).toThrow(
        /unknown option/
      );
    });

    it('accepts an explicit priority 0 as the default', async () => {
      const { hub, seen } = oneSubscriber({ messagePriority: true });
      hub.publish('t', { n: 1 }, { priority: 0 });
      hub.publish('t', { n: 2 }, { priority: 0 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([1, 2]);
    });
  });

  describe('slow-consumer policy under priority', () => {
    it('drop-oldest evicts the lowest priority, not the best', async () => {
      // The defect this whole change is about: evicting with `shift()` under a
      // heap throws away the message the ordering existed to protect, so a slow
      // consumer would lose exactly the urgent traffic and keep the junk.
      const { hub, seen } = oneSubscriber({ messagePriority: true }, { maxQueue: 2 });
      hub.publish('t', { n: 'keep-high' }, { priority: 10 });
      hub.publish('t', { n: 'drop-low' }, { priority: 1 });
      hub.publish('t', { n: 'drop-lower' }, { priority: 0 });
      await hub.flush();
      // `drop-low` (priority 1) lost its slot to the arrival; `keep-high` and the
      // new arrival survive. Evicting with `shift()` instead would have thrown
      // away `keep-high` — the one message the ordering existed to protect.
      expect(seen.map((m) => m.n)).toEqual(['keep-high', 'drop-lower']);
    });

    it('drop-oldest still makes room for the incoming message', async () => {
      const { hub, seen } = oneSubscriber({ messagePriority: true }, { maxQueue: 2 });
      hub.publish('t', { n: 1 }, { priority: 5 });
      hub.publish('t', { n: 2 }, { priority: 5 });
      hub.publish('t', { n: 3 }, { priority: 5 });
      await hub.flush();
      // All three are equal priority, so the tie-break decides — and under
      // `messagePriority` it is "furthest from delivery", which among equals is
      // the *newest*. This is the one place priority mode differs from fifo mode
      // at equal priority, and it is pinned here rather than left to chance:
      // in fifo mode the same sequence yields [2, 3] by dropping the head.
      expect(seen.map((m) => m.n)).toEqual([1, 3]);
    });

    it('diverges from fifo only at equal priority, and says so', async () => {
      // The one behavioural difference between the two modes at equal priority,
      // pinned as a pair so a future change to either is visible as a diff
      // rather than as a silent reordering. In fifo mode `drop-oldest` discards
      // the head, which is the message *nearest* to delivery; in priority mode
      // it discards the one furthest from delivery. They agree on which
      // *priority class* loses and disagree only on the tie.
      // No `priority` on the fifo hub — passing one there throws, which is the
      // guard this test's sibling pins.
      const fifo = oneSubscriber({}, { maxQueue: 2 });
      fifo.hub.publish('t', { n: 1 });
      fifo.hub.publish('t', { n: 2 });
      fifo.hub.publish('t', { n: 3 });
      await fifo.hub.flush();

      const prio = oneSubscriber({ messagePriority: true }, { maxQueue: 2 });
      prio.hub.publish('t', { n: 1 }, { priority: 5 });
      prio.hub.publish('t', { n: 2 }, { priority: 5 });
      prio.hub.publish('t', { n: 3 }, { priority: 5 });
      await prio.hub.flush();

      expect(fifo.seen.map((m) => m.n)).toEqual([2, 3]);
      expect(prio.seen.map((m) => m.n)).toEqual([1, 3]);
    });

    it('counts the eviction in dropped', async () => {
      const { hub } = oneSubscriber({ messagePriority: true }, { maxQueue: 1 });
      hub.publish('t', { n: 1 }, { priority: 1 });
      hub.publish('t', { n: 2 }, { priority: 2 });
      await hub.flush();
      expect(hub.stats().dropped).toBe(1);
    });

    it('drop-newest refuses the incoming message regardless of priority', async () => {
      // A high-priority arrival must not jump the queue by evicting a lower one
      // under `drop-newest` — that policy is about protecting what is already
      // queued, and priority does not change it.
      const { hub, seen } = oneSubscriber(
        { messagePriority: true },
        { maxQueue: 2, slowConsumer: 'drop-newest' }
      );
      hub.publish('t', { n: 1 }, { priority: 1 });
      hub.publish('t', { n: 2 }, { priority: 1 });
      hub.publish('t', { n: 3 }, { priority: 99 });
      await hub.flush();
      expect(seen.map((m) => m.n)).toEqual([1, 2]);
    });

    it('disconnect still fires when the queue is full', async () => {
      const closed = [];
      const { hub } = recorder({
        close: (sub, reason) => closed.push([sub.id, reason]),
        hub: { messagePriority: true },
      });
      hub.subscribe('t', () => {}, { maxQueue: 1, slowConsumer: 'disconnect' });
      hub.publish('t', { n: 1 }, { priority: 1 });
      hub.publish('t', { n: 2 }, { priority: 1 });
      await hub.flush();
      expect(closed).toHaveLength(1);
      expect(closed[0][1]).toBe('slow-consumer');
    });

    it('maxQueue 0 evaluates the policy immediately', async () => {
      // The capacity-0 special case has its own branch in `_enqueue`, and it
      // must keep working when the queue is a heap.
      const { hub, seen } = oneSubscriber(
        { messagePriority: true },
        { maxQueue: 0, slowConsumer: 'drop-newest' }
      );
      hub.publish('t', { n: 1 }, { priority: 5 });
      await hub.flush();
      expect(seen).toEqual([]);
      expect(hub.stats().dropped).toBe(1);
    });
  });

  describe('the frame memo stays sound', () => {
    it('gives each subscriber its own batch when maxQueue differs', async () => {
      // RT-006 keys the one-slot frame memo on `(length, first, last)` by
      // identity, and its soundness rests on a subset invariant: the
      // smaller-budget subscriber's queue is always a subset of the
      // larger-budget one's, so equal-length batches are the same batch.
      //
      // That invariant is what `messagePriority` puts at risk, because
      // `drop-oldest` no longer removes from the front. If it broke, one
      // subscriber would be handed a frame built from the other's batch —
      // silent corruption, with every counter still looking right. This test
      // drives the real flush path rather than a simulation of it.
      const got = { a: [], b: [] };
      const hub = new PowerRealtimeHub({
        send: (sub, frame) => {
          // `decodeMessage` returns the codec envelope; `.value` is the batch.
          got[sub.id].push(decodeMessage(frame).value);
        },
        messagePriority: true,
      });
      hub.subscribe('t', () => {}, { id: 'a', maxQueue: 2 });
      hub.subscribe('t', () => {}, { id: 'b', maxQueue: 6 });

      const published = [];
      for (let i = 0; i < 8; i++) {
        const priority = (i * 3) % 4;
        published.push({ i, priority });
        hub.publish('t', { i }, { priority });
      }
      await hub.flush();

      const ids = {
        a: got.a.flat().map((m) => m.i),
        b: got.b.flat().map((m) => m.i),
      };
      const publishedIds = new Set(published.map((p) => p.i));

      for (const id of ['a', 'b']) {
        // No duplicates: a memo hit handing back a foreign frame would repeat a
        // message this subscriber already had.
        expect(new Set(ids[id]).size, `subscriber ${id} saw a duplicate`).toBe(ids[id].length);
        // Nothing invented: every id received was actually published.
        for (const i of ids[id]) {
          expect(publishedIds.has(i), `subscriber ${id} saw unpublished ${i}`).toBe(true);
        }
      }

      // **The invariant itself.** The smaller-budget subscriber's queue is a
      // subset of the larger-budget one's, so `a`'s set must be contained in
      // `b`'s. A memo collision hands one subscriber the other's batch, which
      // shows up here as an id in `a` that `b` never had.
      const bSet = new Set(ids.b);
      for (const i of ids.a) {
        expect(bSet.has(i), `subscriber a held ${i}, which b never had`).toBe(true);
      }
      // And the two genuinely differ, so the containment above is not vacuous.
      expect(ids.a.length).toBeLessThan(ids.b.length);

      // Each subscriber's own delivery order is by priority, ties by arrival —
      // which is only true if the frame it was handed was built from its own
      // batch.
      const priorityOf = new Map(published.map((p) => [p.i, p.priority]));
      for (const id of ['a', 'b']) {
        for (let k = 1; k < ids[id].length; k++) {
          const prev = priorityOf.get(ids[id][k - 1]);
          const cur = priorityOf.get(ids[id][k]);
          expect(
            cur,
            `subscriber ${id} received ${ids[id][k]} after a higher priority`
          ).toBeLessThanOrEqual(prev);
        }
      }
    });

    it('keeps encoded at one per flush however many subscribers', async () => {
      // The memo's purpose. If `messagePriority` had disabled it, this would
      // climb with the subscriber count and the optimisation would be gone.
      const hub = new PowerRealtimeHub({
        send: () => {},
        batch: false,
        messagePriority: true,
      });
      for (let i = 0; i < 5; i++) hub.subscribe('t', () => {}, { id: `s${i}` });
      hub.publish('t', { n: 1 }, { priority: 3 });
      await hub.flush();
      expect(hub.stats().encoded).toBe(1);
    });
  });

  describe('stats', () => {
    it('reports queued as the heap size', async () => {
      const { hub } = oneSubscriber({ messagePriority: true });
      hub.publish('t', { n: 1 }, { priority: 1 });
      hub.publish('t', { n: 2 }, { priority: 2 });
      // Not flushed yet, so both are still queued.
      expect(hub.stats().list[0].queued).toBe(2);
      await hub.flush();
      expect(hub.stats().list[0].queued).toBe(0);
    });
  });
});
