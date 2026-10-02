import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PowerWebSocketClient } from '../src/index.js';

/**
 * GAP-010 — an **elapsed-time** bound on reconnection, alongside
 * `maxReconnectAttempts`.
 *
 * `maxReconnectAttempts` defaults to `Infinity` and there was no elapsed option
 * at all, so the shipped default was the anti-pattern the row names: *"Should I
 * reconnect a WebSocket forever? No. Set a maximum retry count (10–15) or a
 * maximum elapsed time (2–5 minutes)."* This adds **the option** and leaves the
 * default at `Infinity`, because a finite default is a behaviour change and the
 * row schedules that for 3.0 rather than smuggled into this release.
 *
 * **The budget covers one outage, not the client's lifetime**, and that is the
 * design decision worth stating: it is cleared when a connection opens, so a
 * long-lived connection dropping an hour later gets a fresh window rather than
 * inheriting the previous one's exhaustion. It is therefore the *same* window
 * `maxReconnectAttempts` bounds, and the two compose — `reconnectExhaustedBy`
 * says which one fired.
 */

/** A client whose sockets never open, so every close schedules a reconnect. */
function client(options = {}) {
  const socket = {
    readyState: 3,
    bufferedAmount: 0,
    addEventListener() {},
    removeEventListener() {},
    send() {},
    close() {},
  };
  return new PowerWebSocketClient({
    url: 'ws://example.invalid/',
    autoReconnect: true,
    WebSocketImpl: function FakeSocket() {
      return socket;
    },
    reconnectBaseMs: 10_000,
    reconnectMaxMs: 10_000,
    ...options,
  });
}

/**
 * Stand in for the outage that `_handleClose` records: a connection that dropped
 * `elapsedMs` ago. Driving `_scheduleReconnect` directly would leave the clock
 * unset, and the budget would never be consulted — which is exactly how the
 * first probe of this read 1 attempt for a budget of 0.
 */
function outage(c, elapsedMs = 0) {
  c._reconnectStartedAt = Date.now() - elapsedMs;
}

describe('GAP-010: maxReconnectElapsedMs bounds one reconnect run', () => {
  let c;
  beforeEach(() => {
    c = client();
  });
  afterEach(() => {
    c.close();
    vi.useRealTimers();
  });

  it('defaults to Infinity, which is no bound and preserves current behaviour', () => {
    // The default is deliberate and is the thing GAP-010 is really about: the
    // shipped value stays the anti-pattern until 3.0, and this pins that it is a
    // choice rather than an oversight.
    expect(c._maxReconnectElapsedMs).toBe(Number.POSITIVE_INFINITY);
    outage(c, 0);
    for (let i = 0; i < 5; i += 1) c._scheduleReconnect();
    expect(c._reconnectAttempts, 'no elapsed bound by default').toBe(5);
    expect(c.stats().reconnectExhaustedBy, 'so the clock never fired').toBeNull();
  });

  it('permits no retry at all when the budget is zero', () => {
    // **The off-by-one that matters.** A budget of 0 means no time for even one
    // retry. The first draft started the clock lazily inside
    // `_scheduleReconnect`, which made the first attempt free and let a
    // zero budget through — and a probe caught it only because it drove the real
    // path rather than calling `_scheduleReconnect` on a fresh client.
    c.close();
    c = client({ maxReconnectElapsedMs: 0 });
    outage(c, 0);

    c._scheduleReconnect();

    expect(c._reconnectAttempts, 'zero budget, zero attempts').toBe(0);
    expect(c.stats().reconnectExhaustedBy).toBe('elapsed');
  });

  it('permits a retry inside the budget and stops outside it', () => {
    c.close();
    c = client({ maxReconnectElapsedMs: 10_000 });

    outage(c, 0);
    c._scheduleReconnect();
    expect(c._reconnectAttempts, 'a fresh outage is inside any sane budget').toBe(1);

    // A long outage later: the budget has been spent.
    outage(c, 60_000);
    c._scheduleReconnect();
    c._scheduleReconnect();

    expect(c._reconnectAttempts, 'stopped at the one attempt inside the budget').toBe(1);
    expect(c.stats().reconnectExhaustedBy).toBe('elapsed');
  });

  it('does not count an attempt the clock refused', () => {
    // The exhausted check runs *before* the counter, so a run stopped by the
    // clock does not inflate `reconnects` with attempts that never happened —
    // which matters because `reconnects` is the number an alert watches.
    c.close();
    c = client({ maxReconnectElapsedMs: 1_000 });
    outage(c, 600_000);

    c._scheduleReconnect();

    expect(c._reconnectAttempts).toBe(0);
    expect(c.stats().reconnects, 'and the reconnect counter agrees').toBe(0);
  });

  it('reports which bound fired', () => {
    // Two bounds, two different diagnoses: `'attempts'` suggests the peer is
    // refusing; `'elapsed'` suggests the outage outlived the budget. A caller
    // alerting on `reconnects` alone cannot tell them apart.
    const byElapsed = client({ maxReconnectElapsedMs: 1_000 });
    outage(byElapsed, 600_000);
    byElapsed._scheduleReconnect();
    expect(byElapsed.stats().reconnectExhaustedBy).toBe('elapsed');

    const byCount = client({ maxReconnectAttempts: 1 });
    outage(byCount, 0);
    byCount._scheduleReconnect();
    byCount._scheduleReconnect();
    byCount._scheduleReconnect();
    expect(byCount.stats().reconnectExhaustedBy).toBe('attempts');

    byElapsed.close();
    byCount.close();
  });

  it('clears the budget and the reason when a connection opens', () => {
    // **The "one outage" decision, pinned.** Without this a client that dropped
    // once an hour into its life would exhaust its budget permanently and never
    // reconnect again, which is a strictly worse failure than reconnecting too
    // long. `_handleOpen` is the reset point, alongside `_reconnectAttempts`.
    c.close();
    c = client({ maxReconnectElapsedMs: 1_000 });
    outage(c, 600_000);
    c._scheduleReconnect();
    expect(c.stats().reconnectExhaustedBy).toBe('elapsed');

    // **Through `_handleOpen`, not by hand.** The first draft reset the two
    // fields itself and then asserted they had been reset — which is the
    // vacuous case, and removing the real reset from `_handleOpen` left all
    // eight tests passing. Calling the method is the only version of this
    // assertion that can fail.
    c._handleOpen(() => {});
    c._clearPollTimer?.();
    c._clearHeartbeat?.();
    outage(c, 0);
    c._scheduleReconnect();

    expect(c._reconnectAttempts, 'a later outage gets a fresh window').toBe(1);
    expect(c.stats().reconnectExhaustedBy, 'and nothing is exhausted').toBeNull();
  });

  it('composes with maxReconnectAttempts rather than replacing it', () => {
    // Both bounds are live; whichever trips first is the one reported. A count of
    // 2 with a generous clock is stopped by the count.
    c.close();
    c = client({ maxReconnectAttempts: 2, maxReconnectElapsedMs: 60_000 });
    for (let i = 0; i < 4; i += 1) {
      outage(c, 0);
      c._scheduleReconnect();
    }
    expect(c._reconnectAttempts).toBe(2);
    expect(c.stats().reconnectExhaustedBy).toBe('attempts');
  });

  it('rejects a nonsensical bound rather than coercing it', () => {
    for (const maxReconnectElapsedMs of ['ages', Number.NaN, -1]) {
      expect(() => client({ maxReconnectElapsedMs }), String(maxReconnectElapsedMs)).toThrow(
        TypeError
      );
    }
    // `0` is legitimate — it means "no time for a retry" — so it must not throw.
    const zero = client({ maxReconnectElapsedMs: 0 });
    expect(zero._maxReconnectElapsedMs).toBe(0);
    zero.close();
  });
});
