import { describe, it, expect, beforeAll } from 'vitest';
import { PowerRealtimeHub, decodeMessage, preloadNode } from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/**
 * A transport double that records every frame it is handed, in the order the
 * hub drained subscribers. `batch: false` so each publish schedules its own
 * microtask flush and the recorder sees one frame per subscriber per flush.
 */
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

describe('PowerRealtimeHub subscriber priority (WT-005)', () => {
  it('drains a higher-priority subscriber before a lower one', async () => {
    const { hub, frames } = recorder();
    // Subscribed in low-priority-first order on purpose: the test asserts
    // that priority outranks insertion order, so subscribing the winner last
    // is the discriminating arrangement. If the sort were removed, the winner
    // would be drained second and this test would fail.
    hub.subscribe('news', () => {}, { id: 'low', priority: 0 });
    hub.subscribe('news', () => {}, { id: 'high', priority: 10 });

    hub.publish('news', { n: 1 });
    await hub.flush();

    expect(frames.map((f) => f.id)).toEqual(['high', 'low']);
  });

  it('keeps insertion order when priorities are equal (stable sort)', async () => {
    const { hub, frames } = recorder();
    hub.subscribe('news', () => {}, { id: 'a', priority: 5 });
    hub.subscribe('news', () => {}, { id: 'b', priority: 5 });
    hub.subscribe('news', () => {}, { id: 'c', priority: 5 });

    hub.publish('news', { n: 1 });
    await hub.flush();

    // Array.sort is stable in every engine this package supports, so equal
    // priority must not reorder subscribers that were inserted in order.
    expect(frames.map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('a subscriber with nothing queued is skipped, whatever its priority', async () => {
    const { hub, frames } = recorder();
    hub.subscribe('a', () => {}, { id: 'loud', priority: 100 });
    hub.subscribe('news', () => {}, { id: 'quiet', priority: 1 });

    hub.publish('news', { n: 1 });
    await hub.flush();

    expect(frames.map((f) => f.id)).toEqual(['quiet']);
  });

  it('defaults to priority 0', async () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {}, { id: 'plain' });
    const list = hub.stats().list;
    expect(list.find((s) => s.id === 'plain').priority).toBe(0);
  });

  it('reports the supplied priority back through stats().list', async () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {}, { id: 'p', priority: 7 });
    const list = hub.stats().list;
    expect(list.find((s) => s.id === 'p').priority).toBe(7);
  });

  it('rejects a non-finite priority at subscribe time', () => {
    const { hub } = recorder();
    // `NaN` is the case that matters: it sorts as unequal to everything, so
    // without this check the subscriber lands in an arbitrary position and
    // the caller gets a wrong-order delivery with no error. `Array.sort`
    // does not throw on a comparator returning NaN, so the failure is silent.
    expect(() => hub.subscribe('t', () => {}, { priority: NaN })).toThrow(/priority.*finite/);
    expect(() => hub.subscribe('t', () => {}, { priority: Infinity })).toThrow(/priority.*finite/);
    expect(() => hub.subscribe('t', () => {}, { priority: -Infinity })).toThrow(/priority.*finite/);
    // A string coerces to NaN through `Number()`, which is the usual shape of
    // the mistake, so it is rejected rather than silently becoming 0.
    expect(() => hub.subscribe('t', () => {}, { priority: 'high' })).toThrow(/priority.*finite/);
  });

  it('a higher-priority subscriber on a different topic does not reorder the first', async () => {
    const { hub, frames } = recorder();
    hub.subscribe('news', () => {}, { id: 'n1', priority: 1 });
    hub.subscribe('news', () => {}, { id: 'n2', priority: 9 });
    hub.subscribe('alerts', () => {}, { id: 'a1', priority: 100 });

    hub.publish('news', { n: 1 });
    hub.publish('alerts', { n: 1 });
    await hub.flush();

    // Within a topic priority wins; across topics the order is whatever the
    // flush walk produced, and the two publishes are separate flushes.
    const news = frames.filter((f) => f.id.startsWith('n')).map((f) => f.id);
    expect(news).toEqual(['n2', 'n1']);
  });
});
