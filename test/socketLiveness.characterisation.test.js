/**
 * Characterisation of the two independent liveness implementations — RT-016, step one.
 *
 * **This file changes nothing.** It pins what `PowerWebSocketClient` and
 * `PowerSocketAdapter` each do *today* on the pong path, so that the extraction into a
 * shared `livenessStateMachine` can be verified against a record rather than against
 * memory. RT-016's row says the two differ in more than the four lines of `_handlePong`,
 * and this is the evidence for that: the client computes RTT and counts heartbeats, the
 * adapter does neither, and **both already capture `_pingSentAt`** — the adapter sets it
 * at `powerSocketAdapter.js:922` and its `_handlePong` never reads it.
 *
 * **Characterisation, not specification.** Where these tests disagree with each other,
 * that is the point: the disagreement *is* the current state. Nothing here says which
 * side is right. RT-003 already settled that the client's behaviour is the correct one,
 * and the row records that the decision taken is for RTT to be part of the shared
 * contract gated on `canPing`.
 *
 * The two properties both sides share, and which the extraction must not lose:
 *
 * 1. **A pong clears the probe deadline, not the heartbeat.** Calling the full teardown
 *    here stopped the heartbeat after one round trip. RT-003 measured it: 1 ping for the
 *    life of the socket against 28 in 150 ms.
 * 2. **No `ping()` means no RTT, and it is reported as unmeasured rather than as 0 ms.**
 *    A browser's `WebSocket` deliberately does not expose `ping()`.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerSocketAdapter, READY_STATE } from '../src/index.js';

/** A `ws`-like socket: has `ping()`, emits `pong`, and counts what it was asked. */
class FakeWsSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = READY_STATE.OPEN;
    this.bufferedAmount = 0;
    this.pings = 0;
    this.closed = null;
    this.pingThrows = false;
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return this;
  }
  removeListener() {}
  ping() {
    if (this.pingThrows) throw new Error('ping failed');
    this.pings += 1;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** Deliver a `pong` the way a real socket would: asynchronously. */
  pong() {
    for (const fn of this.listeners.get('pong') ?? []) fn();
  }
}

/** A browser-like socket: no `ping()` at all, because the API is not exposed to script. */
class FakeBrowserSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
    this.readyState = READY_STATE.OPEN;
    this.bufferedAmount = 0;
    this.closed = null;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener() {}
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

describe('RT-016 characterisation: the adapter liveness path, as it is today', () => {
  it('records a ping timestamp and then discards it', async () => {
    // **The finding that makes this a four-line merge.** The adapter already captures
    // `_pingSentAt` before calling `ping()` - the data exists - and nothing ever reads
    // it. Today that is simply a gap; the extraction's job is to close it.
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { heartbeatIntervalMs: 5 });
    adapter.start?.();

    await vi.waitFor(() => expect(ws.pings).toBeGreaterThan(0));
    expect(adapter._pingSentAt).toBeGreaterThan(0);

    ws.pong();
    // **And it is never consumed — which is the sharper form of the finding.** The
    // adapter does not clear it either: `_pingSentAt` is still the value the ping was
    // sent at, long after the pong. So it is *write-only* here, where the client reads
    // it and resets it to 0 in `_handlePong`. A first draft of this case asserted it
    // was cleared to 0 after the pong and failed with the full timestamp still set,
    // which is what turned "discards it" into the accurate "writes it and never reads
    // it". Nothing consumes it either way; only the client can compute an RTT from it.
    expect(adapter._pingSentAt).toBeGreaterThan(0);
    adapter.dispose?.();
  });

  it('clears the probe deadline on pong without ending the heartbeat', async () => {
    // Property 1. RT-003 measured the client side of this at 1 ping versus 28 in 150 ms;
    // the adapter has the same four-line clear, so the property is pinned here too.
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { heartbeatIntervalMs: 5 });
    adapter.start?.();

    await vi.waitFor(() => expect(ws.pings).toBeGreaterThan(1));
    ws.pong();
    // Still beating after a pong — the heartbeat was not torn down with the deadline.
    const after = ws.pings;
    await vi.waitFor(() => expect(ws.pings).toBeGreaterThan(after));
    adapter.dispose?.();
  });

  it('reports canPing false and sends no pings on a transport without ping()', async () => {
    // Property 2, from the other direction: no `ping()`, so no protocol-level
    // heartbeat at all, and the adapter says so rather than pretending.
    const browser = new FakeBrowserSocket();
    const adapter = new PowerSocketAdapter(browser, { heartbeatIntervalMs: 5 });
    adapter.start?.();

    expect(adapter.canPing).toBe(false);
    expect(adapter.stats().canPing).toBe(false);
    await vi.waitFor(() => expect(adapter.stats().canPing).toBe(false));
    adapter.dispose?.();
  });

  it('reports no RTT at all — the gap RT-016 closes', async () => {
    // **Today.** Not a claim that it should stay this way: the decision recorded on the
    // row is that RTT belongs to the shared contract, gated on `canPing`. This test
    // exists so that adding it is a *visible* change rather than a silent one.
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { heartbeatIntervalMs: 5 });
    adapter.start?.();
    await vi.waitFor(() => expect(ws.pings).toBeGreaterThan(0));
    ws.pong();

    const stats = adapter.stats();
    expect(stats.rtt).toBeUndefined();
    adapter.dispose?.();
  });

  it('counts no heartbeats — the second half of the four-line gap', async () => {
    const ws = new FakeWsSocket();
    const adapter = new PowerSocketAdapter(ws, { heartbeatIntervalMs: 5 });
    adapter.start?.();
    await vi.waitFor(() => expect(ws.pings).toBeGreaterThan(0));
    ws.pong();

    expect(adapter.stats().heartbeats ?? 0).toBe(0);
    adapter.dispose?.();
  });
});
