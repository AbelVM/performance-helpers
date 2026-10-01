import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';

/**
 * RT-032 / RT-033 / RT-034 — three defects in `PowerRealtimeHub`, all found by
 * probing the shipped build rather than reading it, and all with the same
 * signature: **a message that never arrives, and no counter that says so.**
 *
 * `test/powerRealtimeHub.test.js` publishes, flushes, asserts, stops. It never
 * publishes *after* a `flush()`, never uses the `raw` codec at all
 * (`rg 'codec'` there returns nothing), and its retain test asserts
 * `seen.length <= 32` on a value that is structurally always `0` — so it cannot
 * fail on the behaviour it names.
 */
describe('RT-032: flush() must not strand the hub', () => {
  it('publishes after an explicit flush still reach the transport', async () => {
    // The regression. `flush()` cleared `_flushTimer` but not `_flushScheduled`,
    // and the timer callback was the only other place that reset it — so with
    // `batchDelayMs > 0` the flag stayed true for the life of the object and
    // `_scheduleFlush` short-circuited on every later publish.
    const sent = [];
    const hub = new PowerRealtimeHub({ send: (s, f) => sent.push(f), batchDelayMs: 50 });
    const off = hub.subscribe('t', () => {});

    hub.publish('t', 1);
    await hub.flush();
    sent.length = 0;

    hub.publish('t', 2);
    await new Promise((r) => setTimeout(r, 100));

    // Before the fix this was 0, and `published` read 2, `delivered` 1 and
    // `dropped` 0 — so the two counters a guide tells you to alert on both
    // reported nothing wrong.
    expect(sent).toHaveLength(1);
    off();
    hub.close();
  });

  it('leaves the hub able to schedule again after flush()', async () => {
    // The flag itself, so the assertion is about the state rather than the
    // side effect: a wedged hub has `scheduled` stuck true.
    const hub = new PowerRealtimeHub({ send: () => {}, batchDelayMs: 50 });
    const off = hub.subscribe('t', () => {});
    hub.publish('t', 1);
    await hub.flush();
    expect(hub._flushScheduled, 'flush() must clear the gate the timer would clear').toBe(false);
    off();
    hub.close();
  });

  it('the default batchDelayMs path is unaffected', async () => {
    // The other strategy, which took a `queueMicrotask` branch that *did* reset
    // the flag. Pinning it so the fix cannot regress the default path.
    const sent = [];
    const hub = new PowerRealtimeHub({ send: (s, f) => sent.push(f) });
    const off = hub.subscribe('t', () => {});
    hub.publish('t', 1);
    await hub.flush();
    sent.length = 0;
    hub.publish('t', 2);
    await hub.flush();
    expect(sent).toHaveLength(1);
    off();
    hub.close();
  });

  it('batch: false still drains only through flush()', async () => {
    // Unbatching returns from `_scheduleFlush` *without* setting the flag, so
    // there is nothing to strand and `flush()` is the only drain. Asserted
    // because it is the control that shows the defect needed `batchDelayMs > 0`
    // rather than any flush at all.
    const sent = [];
    const hub = new PowerRealtimeHub({ send: (s, f) => sent.push(f), batch: false });
    const off = hub.subscribe('t', () => {});
    hub.publish('t', 1);
    expect(sent).toHaveLength(0);
    await hub.flush();
    expect(sent).toHaveLength(1);
    hub.publish('t', 2);
    await hub.flush();
    expect(sent).toHaveLength(2);
    off();
    hub.close();
  });
});

describe('RT-033: the raw codec must not silently discard a batch', () => {
  const payload = () => {
    const b = new Uint8Array(4);
    b[0] = 7;
    return b;
  };

  it('rejects a subscriber whose maxBatch could coalesce', () => {
    // Two `publish` calls in one microtask is the *default* `batch: true` path,
    // and `_flushSubscriber` spliced the batch off `sub.queue` before
    // `_encodeBatch` threw — so both messages were gone. `published: 2,
    // delivered: 0, dropped: 0`: no counter moved, because `dropped` only
    // increments in `_enqueue`, which never saw them.
    const hub = new PowerRealtimeHub({ send: () => {}, codec: 'raw' });
    expect(() => hub.subscribe('t', () => {})).toThrow(/maxBatch/);
    hub.close();
  });

  it('accepts maxBatch: 1 and delivers every message', async () => {
    // The one configuration the hub can honour, and the only thing the error
    // would be useless without.
    const seen = [];
    const hub = new PowerRealtimeHub({ send: () => {}, codec: 'raw' });
    const off = hub.subscribe('t', (m) => seen.push(m), { maxBatch: 1 });
    hub.publish('t', payload());
    hub.publish('t', payload());
    await hub.flush();
    expect(seen).toHaveLength(2);
    off();
    hub.close();
  });

  it('batch: false does not rescue the default maxBatch', () => {
    // Worth pinning because it is the obvious guess and it is wrong: the splice
    // in `_flushSubscriber` is unconditional, so a queue that accumulated two
    // messages while unbatched still yields a two-message batch. Before the fix
    // this configuration lost messages *silently*.
    const hub = new PowerRealtimeHub({ send: () => {}, codec: 'raw', batch: false });
    expect(() => hub.subscribe('t', () => {})).toThrow(/maxBatch/);
    hub.close();
  });

  it('an encode failure is counted rather than vanishing', async () => {
    // The residual path, once the configuration check has caught the common
    // cause. `_flushSubscriber` splices the batch off `sub.queue` *before*
    // `_encodeBatch` runs, so a throw used to discard every message in it with
    // no counter moved. Re-queuing was the obvious fix and is **wrong**: an
    // encode failure is permanent, so a re-queue makes `_drainSubscriberFully`'s
    // `while (queue.length > 0)` spin forever and `flush()` never resolves — the
    // re-queue version hung this very file. So the loss is counted instead.
    const errors = [];
    const hub = new PowerRealtimeHub({
      codec: 'raw',
      send: () => {},
      onError: (e) => errors.push(e),
    });
    const seen = [];
    const off = hub.subscribe('t', (m) => seen.push(m), { maxBatch: 1 });
    // A plain object has no buffer, so `encodeMessage(..., {codec:'raw'})` refuses it.
    hub.publish('t', { not: 'a buffer' });
    await hub.flush();

    const stats = hub.stats();
    expect(seen, 'nothing deliverable, so nothing delivered').toHaveLength(0);
    expect(stats.dropped, 'and the loss is now visible in the counters').toBe(1);
    expect(stats.published).toBe(1);
    expect(stats.delivered).toBe(0);
    expect(errors).toHaveLength(1);
    off();
    hub.close();
  });

  it('flush() still resolves when nothing can be encoded', async () => {
    // The hang, stated as the thing that must not happen. Without this the file
    // would pass its other assertions and then time out.
    const hub = new PowerRealtimeHub({ codec: 'raw', send: () => {}, onError: () => {} });
    const off = hub.subscribe('t', () => {}, { maxBatch: 1 });
    hub.publish('t', { bad: 1 });
    hub.publish('t', { bad: 2 });
    await expect(hub.flush()).resolves.toBeUndefined();
    off();
    hub.close();
  });

  it('the json codec is untouched', () => {
    // The control. A fix that rejected batching outright rather than for one
    // codec would pass the tests above and break every default hub.
    const seen = [];
    const hub = new PowerRealtimeHub({ send: () => {} });
    const off = hub.subscribe('t', (m) => seen.push(m));
    expect(() => hub.publish('t', 1), 'must not throw').not.toThrow();
    off();
    hub.close();
    expect(seen).toHaveLength(0);
  });
});

describe('RT-034: retain must replay, and one unsubscribe must not wipe the topic', () => {
  it('replays the retained log to a subscriber that arrives later', async () => {
    // The JSDoc said "keep the message for a subscriber that subscribes later"
    // and the guide said it "keeps the message for later subscribers". Neither
    // happened: `_retained` was read in exactly two places, its own write path
    // and `_detach`. The late subscriber got [].
    const seen = [];
    const hub = new PowerRealtimeHub({ send: () => {} });
    const off = hub.subscribe('cfg', () => {});
    hub.publish('cfg', 'A', { retain: true });
    hub.publish('cfg', 'B', { retain: true });
    await hub.flush();

    const late = hub.subscribe('cfg', (m) => seen.push(m));
    await hub.flush();
    expect(seen).toEqual(['A', 'B']);
    off();
    late();
    hub.close();
  });

  it('a replay does not inflate the published counter', async () => {
    // The reason replay goes through `_enqueue` and not `publish()`. A replay is
    // not a publication, and routing it through `publish()` would make
    // `published` jump by the length of every retained log on every subscribe —
    // which is exactly how a counter stops being trustworthy.
    const hub = new PowerRealtimeHub({ send: () => {} });
    hub.publish('cfg', 'A', { retain: true });
    hub.publish('cfg', 'B', { retain: true });
    await hub.flush();
    const before = hub.stats().published;
    const off = hub.subscribe('cfg', () => {});
    await hub.flush();
    expect(hub.stats().published).toBe(before);
    off();
    hub.close();
  });

  it('one subscriber leaving does not empty the topic log for the others', async () => {
    // The log is per *topic*; the detach is per *subscriber*. Clearing it
    // unconditionally meant one subscriber leaving destroyed history every
    // other live subscriber on that topic still depended on.
    const hub = new PowerRealtimeHub({ send: () => {} });
    const first = hub.subscribe('cfg', () => {});
    const second = hub.subscribe('cfg', () => {});
    hub.publish('cfg', 'A', { retain: true });
    hub.publish('cfg', 'B', { retain: true });
    await hub.flush();

    first();
    expect(hub.stats().subscribers, 'one of two is still live').toBe(1);
    expect(hub._retained.get('cfg')).toEqual(['A', 'B']);
    second();
    hub.close();
  });

  it('the log is released when the last subscriber leaves', async () => {
    // The other direction, and the reason the check is keyed on the topic
    // bucket rather than on the subscriber: a retained log that outlives every
    // subscriber is a leak, not a feature.
    const hub = new PowerRealtimeHub({ send: () => {} });
    const only = hub.subscribe('cfg', () => {});
    hub.publish('cfg', 'A', { retain: true });
    await hub.flush();
    only();
    expect(hub._retained.get('cfg'), 'nothing left to retain for').toEqual([]);

    const seen = [];
    const off = hub.subscribe('cfg', (m) => seen.push(m));
    await hub.flush();
    expect(seen, 'a cleared log replays nothing').toEqual([]);
    off();
    hub.close();
  });

  it('close() releases every retained log', () => {
    // `_detach` now only empties a log when it was the last subscriber, so a
    // topic whose subscribers detached in a different order would otherwise keep
    // its retained messages alive past `close()`.
    const hub = new PowerRealtimeHub({ send: () => {} });
    const a = hub.subscribe('one', () => {});
    const b = hub.subscribe('two', () => {});
    hub.publish('one', 'A', { retain: true });
    hub.publish('two', 'B', { retain: true });
    hub.unsubscribe('sub-1');
    a();
    hub.close();
    b();
    expect(hub._retained.size).toBe(0);
  });

  it('retains a publish that has no live subscriber', async () => {
    // The second half of the same defect, found while writing the test above:
    // `_retain` sat *below* the `if (!bucket || bucket.size === 0) return 0`
    // early return, so publishing to a topic nobody was listening to retained
    // nothing. That is the case the option exists for — "keep the message for a
    // subscriber that subscribes later" means publishing before anyone is
    // listening, and that is exactly what silently did nothing.
    const hub = new PowerRealtimeHub({ send: () => {} });
    hub.publish('cfg', 'A', { retain: true });
    hub.publish('cfg', 'B', { retain: true });
    expect(hub._retained.get('cfg'), 'publishing into the void still retains').toEqual(['A', 'B']);
    const seen = [];
    const off = hub.subscribe('cfg', (m) => seen.push(m));
    await hub.flush();
    expect(seen).toEqual(['A', 'B']);
    off();
    hub.close();
  });

  it('a replay is subject to the subscriber own queue and policy', async () => {
    // Replay enqueues like any other delivery, so a subscriber that cannot hold
    // the retained log drops it by its own policy rather than silently missing
    // it. `maxQueue: 0` is the extreme case and is the honest one: this is what
    // `drop-oldest` on a full queue means, and it is a *deliberate* loss the
    // caller chose, not the invisible kind. Before the replay existed there was
    // nothing to be subject to anything.
    const hub = new PowerRealtimeHub({ send: () => {} });
    for (let i = 0; i < 5; i += 1) hub.publish('cfg', i, { retain: true });

    const seen = [];
    const off = hub.subscribe('cfg', (m) => seen.push(m), {
      maxQueue: 0,
      slowConsumer: 'drop-oldest',
    });
    await hub.flush();
    expect(seen, 'maxQueue: 0 keeps nothing, by that subscriber own choice').toHaveLength(0);
    expect(hub._subs.get(off && [...hub._subs.keys()][0]).dropped).toBe(5);

    off();
    hub.close();
  });

  it('the retained log stays bounded at 32 per topic', () => {
    // The bound is pre-existing behaviour, and a replay feature makes it
    // user-visible for the first time — so it is pinned rather than assumed.
    const hub = new PowerRealtimeHub({ send: () => {} });
    for (let i = 0; i < 50; i += 1) hub.publish('cfg', i, { retain: true });
    expect(hub._retained.get('cfg')).toHaveLength(32);
    hub.close();
  });
});
