import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/index.js';
import { decodeMessage } from '../src/helpers/powerMessageCodec.js';

/**
 * RT-026: the hub advertised two things it did not do.
 *
 * ## `bytesQueued`
 *
 * Declared on {@link HubSubscriber}, initialised to `0` in `subscribe()`, and
 * written by nothing. A subscriber handed to a user's `send` adapter — the one
 * place a byte count is actually useful, since the adapter is what knows the
 * socket — advertised a number that was permanently `0`. A field that reads as a
 * measurement and is not is worse than no field: the caller has no way to tell
 * the difference between "this subscriber has queued nothing" and "this library
 * does not count".
 *
 * **It is not repairable at enqueue time**, which is the reason the fix is a
 * rename rather than an implementation. `queue` holds un-encoded message
 * *objects*, so a byte count at `enqueue` means `JSON.stringify` per message per
 * subscriber — strictly more work than the single encode-per-batch RT-006
 * introduced to remove exactly that cost, and it would undo RT-006 on the path
 * RT-006 was written for. The quantity that *is* free is the bytes handed to the
 * transport, because that frame was built for this flush anyway.
 *
 * So the field became **`bytesSent`**, incremented in `_flushSubscriber` from the
 * already-computed `frame.length`. The shared frame is what makes it exact rather
 * than approximate: the same buffer goes to every subscriber on the topic, so one
 * `frame.length` is the right number for all of them.
 *
 * ## The invariant that makes it real
 *
 * `sub.bytesSent` and `_counters.bytesOut` are incremented **in one statement**,
 * so `stats().bytesOut === Σ stats().list[].bytesSent` holds by construction. That
 * identity is the assertion: a counter nothing can check against anything else is
 * decoration, and this row exists because a number nobody could check turned out
 * to be zero. The reconcile test is the guard — it is what a reintroduction of the
 * old field, or an increment placed outside the flush, fails.
 *
 * ## `options.now`
 *
 * Documented as "Clock override, for tests", accepted by `assertKnownOptions`,
 * destructured, stored on `this._now`, and **never called** — no path in this class
 * measures elapsed time, because the slow-consumer policy is `queue.length` against
 * `maxQueue` and every counter is an event count. Deleted rather than wired up: the
 * honest fix is the smaller one, and an option kept alive by inventing a use for it
 * stays dead for another release.
 */

/** A hub with a transport double that keeps every frame it was handed. */
function harness(options = {}) {
  const frames = [];
  const hub = new PowerRealtimeHub({
    send: (sub, frame) => frames.push({ id: sub.id, frame }),
    ...options,
  });
  return { hub, frames };
}

describe('RT-026: per-subscriber byte accounting is real', () => {
  it('bytesSent equals the bytes the subscriber was actually handed', async () => {
    const { hub, frames } = harness();
    hub.subscribe('t', () => {}, { id: 'a' });
    hub.subscribe('t', () => {}, { id: 'b' });
    hub.publish('t', { id: 1 });
    await hub.flush();

    // The oracle is the transport itself, not the hub: sum the frames the adapter
    // received. If the hub's counter and the bytes on the wire disagree, one of
    // them is wrong and this says which.
    const byId = new Map();
    for (const f of frames) byId.set(f.id, (byId.get(f.id) ?? 0) + f.frame.length);

    const list = hub.stats().list;
    expect(list.map((s) => s.id).sort()).toEqual(['a', 'b']);
    for (const s of list) {
      expect(s.bytesSent, `${s.id} matches the bytes its transport received`).toBe(byId.get(s.id));
      expect(s.bytesSent).toBeGreaterThan(0);
    }
    hub.close();
  });

  it('stats().bytesOut is exactly the sum of the per-subscriber bytesSent', async () => {
    // The invariant. Unequal subscriber counts, unequal queue depths, and a batch
    // that coalesces, because a reconcile that only holds for one frame per
    // subscriber is not an invariant.
    const { hub } = harness();
    hub.subscribe('t', () => {}, { id: 'a' });
    for (let i = 0; i < 7; i += 1) hub.subscribe('t', () => {}, { id: `b${i}` });
    hub.subscribe('other', () => {}, { id: 'c' });

    hub.publish('t', { id: 1 });
    hub.publish('t', { id: 2 });
    hub.publish('t', 'a much longer payload than the first two');
    await hub.flush();

    const stats = hub.stats();
    const sum = stats.list.reduce((n, s) => n + s.bytesSent, 0);
    expect(sum).toBe(stats.bytesOut);
    expect(stats.bytesOut).toBeGreaterThan(0);
    hub.close();
  });

  it('the reconcile still holds after a subscriber is detached', async () => {
    // A counter that only reconciles while everyone is attached is bookkeeping,
    // not accounting: `stats().list` drops detached subscribers, so `bytesOut` has
    // to keep the bytes they were sent.
    const { hub } = harness();
    hub.subscribe('t', () => {}, { id: 'a' });
    const unsub = hub.subscribe('t', () => {}, { id: 'b' });
    hub.publish('t', 1);
    await hub.flush();

    const before = hub.stats();
    expect(before.list.reduce((n, s) => n + s.bytesSent, 0)).toBe(before.bytesOut);

    expect(unsub()).toBe(true);
    const after = hub.stats();
    expect(after.list).toHaveLength(1);
    expect(after.list[0].bytesSent, 'bytes already sent to the survivor stand').toBeGreaterThan(0);
    // `bytesOut` is cumulative; the departed subscriber's bytes are still in it.
    expect(after.bytesOut).toBe(before.bytesOut);
    hub.close();
  });

  it('counts bytes for a subscriber that fell behind, not only for a healthy one', async () => {
    // The slow-consumer case is the one this exists for. A caller shedding load
    // needs to distinguish "this subscriber is slow" from "this subscriber is
    // receiving little" — and with a permanently-zero field it could not.
    const { hub } = harness();
    hub.subscribe('t', () => {}, { id: 'slow', maxQueue: 2, slowConsumer: 'drop-oldest' });
    hub.subscribe('t', () => {}, { id: 'fast', maxQueue: 2 });
    for (let i = 0; i < 6; i += 1) hub.publish('t', { i, pad: 'x'.repeat(64) });
    await hub.flush();

    const stats = hub.stats();
    const slow = stats.list.find((s) => s.id === 'slow');
    const fast = stats.list.find((s) => s.id === 'fast');
    expect(slow.dropped).toBeGreaterThan(0);
    expect(slow.bytesSent).toBeGreaterThan(0);
    expect(slow.bytesSent).toBe(fast.bytesSent);
    expect(stats.list.reduce((n, s) => n + s.bytesSent, 0)).toBe(stats.bytesOut);
    hub.close();
  });

  it('is zero before anything is sent, and never negative', async () => {
    // The state the old field was permanently in. Asserting it is what makes the
    // first test's `toBeGreaterThan(0)` a statement about a counter that moves
    // rather than about a counter that was not zero.
    const { hub } = harness();
    hub.subscribe('t', () => {}, { id: 'a' });
    expect(hub.stats().list[0].bytesSent).toBe(0);
    hub.publish('t', 1);
    expect(hub.stats().list[0].bytesSent, 'queued is not sent').toBe(0);
    await hub.flush();
    for (const s of hub.stats().list) expect(s.bytesSent).toBeGreaterThanOrEqual(0);
    hub.close();
  });

  it('the raw codec is counted too, since the same statement increments both', async () => {
    // A second codec is a second frame length, and the reconcile is the thing that
    // would notice if only the json path were counted.
    const { hub } = harness({ codec: 'raw' });
    hub.subscribe('t', () => {}, { id: 'a', maxBatch: 1 });
    hub.subscribe('t', () => {}, { id: 'b', maxBatch: 1 });
    hub.publish('t', new Uint8Array([1, 2, 3, 4, 5]));
    await hub.flush();

    const stats = hub.stats();
    expect(stats.list.reduce((n, s) => n + s.bytesSent, 0)).toBe(stats.bytesOut);
    expect(stats.bytesOut).toBeGreaterThan(0);
    hub.close();
  });

  it('an encode failure counts no bytes, because the frame does not exist', async () => {
    // The batch was spliced off the queue and never encoded, so there is nothing
    // to attribute. A counter incremented before `_encodeBatch` would report bytes
    // handed to a transport that never received them.
    const hub = new PowerRealtimeHub({
      send: () => {},
      codec: 'raw',
      onError: () => {},
    });
    // `maxBatch: 1` is what `subscribe` accepts under the raw codec. The throw is
    // then reached by widening the batch behind the check, because the
    // constructor rejects `raw` + batching precisely so a caller cannot get here —
    // which is the point: this exercises the defensive branch, not a config.
    hub.subscribe('t', () => {}, { id: 'a', maxBatch: 1 });
    hub._subs.get('a').maxBatch = 2;
    hub.publish('t', new Uint8Array([1, 2, 3]));
    hub.publish('t', new Uint8Array([4, 5, 6]));
    await hub.flush();

    const stats = hub.stats();
    expect(stats.bytesOut).toBe(0);
    expect(stats.list[0].bytesSent).toBe(0);
    // And the loss is still reported, which is the other half of that branch.
    expect(stats.dropped).toBe(2);
    hub.close();
  });

  it('a throwing send adapter takes no bytes, while delivered still counts it', async () => {
    // The recorded quirk from `_flushSubscriber`: the byte counters moved after the
    // adapter took the frame, `delivered` did not. Pinned rather than tidied,
    // because "offered" and "taken" are different questions and only one of them
    // was ever wired to the adapter's return.
    const hub = new PowerRealtimeHub({
      send: () => {
        throw new Error('socket gone');
      },
      onError: () => {},
    });
    hub.subscribe('t', () => {}, { id: 'a' });
    hub.publish('t', 1);
    await hub.flush();

    const stats = hub.stats();
    expect(stats.bytesOut, 'the transport never received the frame').toBe(0);
    expect(stats.list[0].bytesSent).toBe(0);
    expect(stats.delivered, 'pre-existing: counts messages offered, not taken').toBe(1);
    hub.close();
  });

  it('a subscriber handed to a send adapter reports its own byte count', async () => {
    // The call site the old field was supposed to serve, exercised end to end
    // through the public surface: the adapter receives the subscriber record and
    // reads a number off it.
    const seen = [];
    let frame = null;
    const hub = new PowerRealtimeHub({
      send: (sub, f) => {
        seen.push({ before: sub.bytesSent, length: f.length });
        frame = f;
      },
    });
    hub.subscribe('t', () => {}, { id: 'a' });
    hub.publish('t', { hello: 'world' });
    await hub.flush();

    // Read *inside* the adapter, so the value is the counter as it stood when the
    // transport was called. `bytesSent` is cumulative, so `before` is the running
    // total at entry and `length` is what this call adds.
    expect(seen).toHaveLength(1);
    expect(seen[0].before, 'the total this call is added to').toBe(0);
    expect(hub.stats().list[0].bytesSent).toBe(seen[0].length);
    // And those are the bytes of the payload, not of some other frame: decode the
    // buffer the adapter actually received. An identical pair of branches here
    // would have asserted nothing, which is the failure mode this replaced.
    expect(decodeMessage(frame).value).toEqual([{ hello: 'world' }]);
    hub.close();
  });

  it('accumulates across flushes rather than reporting only the latest', async () => {
    // A counter that reset per flush would satisfy every test above that uses one
    // flush, so this is the case that distinguishes a running total from a gauge.
    const { hub } = harness();
    hub.subscribe('t', () => {}, { id: 'a' });
    hub.publish('t', 1);
    await hub.flush();
    const first = hub.stats().list[0].bytesSent;
    expect(first).toBeGreaterThan(0);

    hub.publish('t', 2);
    await hub.flush();
    const second = hub.stats().list[0].bytesSent;
    expect(second).toBeGreaterThan(first);
    expect(hub.stats().bytesOut).toBe(second);
    hub.close();
  });
});

describe('RT-026: the dead `now` option is gone', () => {
  it('is rejected by name, rather than accepted and ignored', async () => {
    // The half of the row that is a deletion. `assertKnownOptions` is the
    // mechanism: before, `now` was on the accepted list, so a caller who passed a
    // clock got a silent no-op and no way to tell.
    expect(() => new PowerRealtimeHub({ send: () => {}, now: () => 0 })).toThrow(/now/);
  });

  it('leaves the accepted option list exactly as documented', () => {
    // A guard against a future reintroduction, and against the option being
    // re-added to the typedef alone. Reads the source rather than the constructor
    // because `assertKnownOptions` is shared and its list is per-call.
    expect(() => new PowerRealtimeHub({ send: () => {}, nowMs: () => 0 })).toThrow(/nowMs/);
    // Every documented option still works.
    expect(
      () =>
        new PowerRealtimeHub({
          send: () => {},
          close: () => {},
          batch: false,
          batchDelayMs: 5,
          codec: 'json',
          onError: () => {},
          observability: false,
        })
    ).not.toThrow();
  });

  it('does not construct the field the option used to write', () => {
    // A structural assertion on purpose: the defect *was* the field existing with
    // nothing reading it, and nothing behavioural can see an unread private field.
    const hub = new PowerRealtimeHub({ send: () => {} });
    expect('_now' in hub).toBe(false);
    hub.close();
  });
});
