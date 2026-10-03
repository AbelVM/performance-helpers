import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/index.js';
import { PowerWebSocketClient } from '../src/index.js';

/**
 * DX-005 — 21 helpers implemented `[Symbol.dispose]` and only two implemented
 * `[Symbol.asyncDispose]`, so `await using x = new PowerRealtimeHub(…)` did not
 * participate in teardown at all: `await using` requires `asyncDispose`, and
 * without it the hub was simply never disposed, which is worse than being
 * disposed ungracefully.
 *
 * **The graceful difference, measured on the hub.** With `batchDelayMs > 0` a hub
 * can be holding frames that have been `publish`ed but not yet sent:
 *
 * | teardown                | sends observed |
 * | ----------------------- | -------------- |
 * | `hub[Symbol.dispose]()` | **0**          |
 * | `await hub[Symbol.asyncDispose]()` | **1** |
 *
 * `close()` is not graceful — it clears the pending batch along with everything
 * else — so the sync path silently drops frames that were counted as published.
 * That is what `asyncDispose` is for, and it is the same shape `PowerPool` already
 * used: flush, swallow flush failures, then tear down.
 */

/** A hub with one subscriber and one published-but-unsent frame. */
function hubWithPendingFrame(batchDelayMs = 50) {
  const sends = [];
  const hub = new PowerRealtimeHub({ send: (topic) => sends.push(topic) }, { batchDelayMs });
  hub.subscribe('t', () => {});
  hub.publish('t', { n: 1 });
  return { hub, sends };
}

describe('DX-005: PowerRealtimeHub asyncDispose flushes before it closes', () => {
  it('sends the pending batch that dispose() would drop', async () => {
    // The whole reason this is not just a delegation.
    const dropped = hubWithPendingFrame();
    dropped.hub[Symbol.dispose]();
    expect(dropped.sends.length, 'the sync path drops what was published').toBe(0);

    const flushed = hubWithPendingFrame();
    await flushed.hub[Symbol.asyncDispose]();
    expect(flushed.sends.length, 'the async path gets it out first').toBe(1);
  });

  it('leaves the hub closed either way', async () => {
    // Teardown is teardown; the async hook is not a licence to leave it open.
    // Asserted on `_closed` and on the subscriber count rather than on a
    // `status` field — this `getStats()` returns counters and a `list`, and an
    // earlier draft asserted `status === 'closed'` against a shape that has no
    // such key.
    const { hub } = hubWithPendingFrame();
    await hub[Symbol.asyncDispose]();

    expect(hub._closed).toBe(true);
    expect(hub.getStats().subscribers, 'subscribers detached').toBe(0);
    expect(hub.getStats().topics, 'topics released').toBe(0);
  });

  it('is idempotent, since scope exit can reach it after an explicit close', async () => {
    const { hub, sends } = hubWithPendingFrame();
    await hub[Symbol.asyncDispose]();
    await hub[Symbol.asyncDispose]();
    await hub[Symbol.asyncDispose]();

    expect(sends.length, 'the batch is flushed once, not three times').toBe(1);
    expect(hub._closed).toBe(true);
  });

  it('closes even when the flush rejects', async () => {
    // **The reason the flush is wrapped in a try/catch.** A disposal path must
    // not be abandonable: if a flush throws and `close()` never runs, the hub is
    // left open with listeners attached, which is strictly worse than losing the
    // batch. Same reasoning as `PowerPool`, and it is asserted rather than
    // assumed because "swallow the error" is otherwise indistinguishable from
    // "forgot to handle it".
    //
    // **No claim is made about whether the frame was sent.** An earlier draft
    // asserted `sends === 0` and failed at 1, correctly: replacing the public
    // `flush()` does not stop the hub's own timer or microtask from sending, and
    // it should not. The property under test is that the hub ends up closed.
    const { hub } = hubWithPendingFrame();
    hub.flush = () => Promise.reject(new Error('flush exploded'));

    await expect(hub[Symbol.asyncDispose]()).resolves.toBeUndefined();

    expect(hub._closed, 'closed despite the flush failure').toBe(true);
    expect(hub.getStats().subscribers, 'and detached').toBe(0);
  });

  it('does nothing on an already-closed hub', async () => {
    const { hub, sends } = hubWithPendingFrame();
    hub.close();

    await hub[Symbol.asyncDispose]();

    expect(sends.length, 'a closed hub has nothing to flush').toBe(0);
    expect(hub._closed).toBe(true);
  });

  it('flushes nothing when batchDelayMs is 0, and still closes', async () => {
    // The common case: no batching, so there is no pending frame and `flush()`
    // has nothing to await. The hook must still close the hub — a delegation that
    // only flushed would leave it open.
    const sends = [];
    const hub = new PowerRealtimeHub({ send: (t) => sends.push(t) }, { batchDelayMs: 0 });
    hub.subscribe('t', () => {});
    hub.publish('t', { n: 1 });

    await hub[Symbol.asyncDispose]();

    expect(sends.length, 'published straight through').toBe(1);
    expect(hub._closed).toBe(true);
  });
});

describe('DX-005: PowerWebSocketClient asyncDispose exists and is a delegation', () => {
  /** The client only constructs against a real URL; `close()` on a dead socket is a no-op. */
  const client = () => new PowerWebSocketClient({ url: 'ws://127.0.0.1:1/', autoReconnect: false });

  it('is present, which is the gap this row names', async () => {
    // Without it, `await using client = new PowerWebSocketClient(…)` **never
    // disposed the client at all** — a silent no-op rather than an ungraceful
    // one, which is the worse failure because nothing looks wrong.
    const c = client();
    expect(typeof c[Symbol.asyncDispose]).toBe('function');

    await c[Symbol.asyncDispose]();

    expect(c.getStats().readyState, 'closed, as dispose() would have left it').not.toBe(0);
  });

  it('closes the socket, matching dispose() exactly', async () => {
    // **Why a delegation and not a graceful path.** This client's teardown is
    // `close()`, which is synchronous and already complete — unlike the hub,
    // which holds pending frames. Inventing an awaitable variant would be a
    // promise resolving immediately and implying a graceful path that does not
    // exist. `PowerPool` drains because it has something to drain.
    const c = client();
    const viaDispose = client();

    c.dispose();
    await viaDispose[Symbol.asyncDispose]();

    expect(viaDispose.getStats().readyState).toBe(c.getStats().readyState);
  });

  it('detaches metrics, so the observability hook is released too', async () => {
    // `dispose()` does more than `close()` — it detaches the metrics sink
    // (`powerWebSocketClient.js:539`). An async hook that called only `close()`
    // would leave that attached, so this pins the delegation to `dispose()`.
    //
    // **`observability: true` is load-bearing, and its absence made this test
    // vacuous.** An earlier draft constructed a plain client and asserted
    // `_metrics` was null after disposal — which is null on a fresh instance
    // anyway, because metrics are opt-in. It passed 9/9 *and* passed unchanged
    // against a mutant where `asyncDispose` called `close()` directly, which is
    // the only way to know it was asserting nothing. `attach()` returns `null`
    // unless `observability` is truthy, so without the option the sink was never
    // attached and the test could not have failed.
    const c = new PowerWebSocketClient({
      url: 'ws://127.0.0.1:1/',
      autoReconnect: false,
      observability: true,
    });
    expect(c._metrics, 'metrics really are attached before disposal').not.toBeNull();

    await c[Symbol.asyncDispose]();

    expect(c._metrics, 'metrics detached exactly as dispose() does').toBeNull();
  });
});
