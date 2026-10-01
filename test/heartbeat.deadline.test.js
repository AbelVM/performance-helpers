/**
 * RT-008: one orphan heartbeat timer per tick.
 *
 * The heartbeat armed a deadline for every ping, and the handle was only cleared
 * when a **pong** arrived. A socket that never answers therefore re-armed on
 * every tick and *overwrote* the handle: one orphan timer per tick, none of them
 * clearable, and each firing later to increment `heartbeatTimeouts`, call
 * `_clearTimers()` and close the socket — a spurious close driven by a timer
 * nobody was tracking.
 *
 * Measured before the fix, three ticks against a socket whose `ping()` is never
 * answered: **three deadlines armed, zero cleared.** After: **one armed, one
 * live.**
 *
 * **The row's prescription was only half right, and the other half is the more
 * dangerous one.** "Clear the handle before re-arming" does remove the orphan,
 * but it also *resets the window*: the deadline measures from the ping, so
 * clearing and re-arming on every tick means a socket that never answers **never
 * times out at all** whenever `heartbeatTimeoutMs` exceeds `heartbeatIntervalMs`
 * — trading a spurious close for a permanently-dead-looking socket that reports
 * itself alive. That is worse, and two existing tests caught it when the first
 * version of the fix did exactly what the row said. The deadline is now armed
 * **once per live window** and left alone while one is outstanding.
 *
 * The instrument is a count of timer allocations against releases, not a
 * duration — the same one PERF-001 and POOL-006 use, because counting is exact
 * and a duration would be measuring the thing being removed. Both transport
 * files are covered, as the row requires; the bug was duplicated in both.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { PowerSocketAdapter } from '../src/helpers/powerSocketAdapter.js';
import { PowerWebSocketClient } from '../src/helpers/powerWebSocketClient.js';

/** @type {Array<any>} */
const disposables = [];

afterEach(() => {
  for (const d of disposables.splice(0)) {
    try {
      d.dispose();
    } catch {
      /* already gone */
    }
  }
});

/**
 * Count timer allocations and releases for the duration of `fn`.
 *
 * A gap between the two is an orphan: a handle that was taken and never
 * released. The one legitimate live handle is accounted for by the caller.
 *
 * @param {() => void} fn
 * @returns {{armed: number, cleared: number}}
 */
function countTimers(fn) {
  const realST = globalThis.setTimeout;
  const realCT = globalThis.clearTimeout;
  let armed = 0;
  let cleared = 0;
  globalThis.setTimeout = function (/** @type {any} */ ...args) {
    armed += 1;
    // @ts-expect-error - forwarding the platform's own signature
    return realST.apply(this, args);
  };
  globalThis.clearTimeout = function (/** @type {any} */ h) {
    cleared += 1;
    return realCT(h);
  };
  try {
    fn();
  } finally {
    globalThis.setTimeout = realST;
    globalThis.clearTimeout = realCT;
  }
  return { armed, cleared };
}

/** A `ws`-shaped socket that accepts a ping and never answers it. */
function silentSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    on: () => {},
    send: () => {},
    close: () => {},
    ping: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('PowerSocketAdapter: one heartbeat deadline per live window', () => {
  it('arms one deadline across many unanswered pings, not one per tick', () => {
    // The defect. Three ticks, three pings, three deadlines armed and zero
    // cleared — so every one of them was an orphan that could still fire.
    const socket = silentSocket();
    const adapter = new PowerSocketAdapter(/** @type {any} */ (socket), {
      kind: 'ws',
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    });
    disposables.push(adapter);
    adapter._attach();

    const { armed, cleared } = countTimers(() => {
      for (let i = 0; i < 3; i += 1) adapter._tickHeartbeat();
    });

    // Three pings went out…
    expect(socket.ping).toBeDefined();
    // …and exactly one deadline exists. Before the fix this read 3.
    expect(armed).toBe(1);
    expect(cleared).toBe(0);
    expect(adapter._heartbeatDeadline).not.toBeNull();
  });

  it('re-arms after a pong clears the window', () => {
    // The counterpart, and the reason the guard is on the *arm* rather than
    // being a clear-then-arm: a pong ends the window, so the next tick must be
    // able to start a new one. If this did not hold, a healthy socket would stop
    // being timed out after its first pong.
    const adapter = new PowerSocketAdapter(/** @type {any} */ (silentSocket()), {
      kind: 'ws',
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    });
    disposables.push(adapter);
    adapter._attach();

    const first = countTimers(() => adapter._tickHeartbeat());
    expect(first.armed).toBe(1);

    // A pong arrives: the window closes.
    const pong = countTimers(() => adapter._handlePong());
    expect(pong.cleared).toBe(1);
    expect(adapter._heartbeatDeadline).toBeNull();

    // The next tick starts a fresh window.
    const second = countTimers(() => adapter._tickHeartbeat());
    expect(second.armed).toBe(1);
    expect(adapter._heartbeatDeadline).not.toBeNull();
  });

  it('leaves no orphan behind for a caller to trip over', () => {
    // The consequence, stated as a shape: exactly one handle is reachable, so
    // `_clearTimers` can always find it. Before the fix, `_clearTimers` could
    // only ever clear the most recent one and the rest fired on their own.
    const adapter = new PowerSocketAdapter(/** @type {any} */ (silentSocket()), {
      kind: 'ws',
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    });
    disposables.push(adapter);
    adapter._attach();
    for (let i = 0; i < 5; i += 1) adapter._tickHeartbeat();

    expect(adapter._heartbeatDeadline).not.toBeNull();
    countTimers(() => adapter._clearTimers());
    // The property, not a count of `clearTimeout` calls: `_clearTimers` also
    // releases the heartbeat *interval* timer, so the number of clears is 2 and
    // asserting 1 failed for a reason that had nothing to do with orphans.
    expect(adapter._heartbeatDeadline).toBeNull();
  });
});

describe('PowerWebSocketClient: the same guard, in the other transport file', () => {
  it('arms one deadline across many unanswered pings', () => {
    // The row says "in **both** transport files", and the bug was duplicated:
    // the fix had to be too, or the client kept orphaning a timer per tick.
    const socket = silentSocket();
    // A single options object with `url` inside it - the first version passed
    // `(url, options)` and the constructor read `url` from the first argument's
    // absence, throwing "must be a non-empty string" for a URL that was right
    // there.
    const client = new PowerWebSocketClient({
      url: 'ws://example.invalid',
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    });
    disposables.push(client);
    client._socket = /** @type {any} */ (socket);

    const { armed } = countTimers(() => {
      for (let i = 0; i < 3; i += 1) client._tickHeartbeat();
    });

    expect(armed).toBe(1);
    expect(client._heartbeatDeadline).not.toBeNull();
  });

  it('re-arms once the window is closed', () => {
    // A single options object with `url` inside it - the first version passed
    // `(url, options)` and the constructor read `url` from the first argument's
    // absence, throwing "must be a non-empty string" for a URL that was right
    // there.
    const client = new PowerWebSocketClient({
      url: 'ws://example.invalid',
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 100,
    });
    disposables.push(client);
    client._socket = /** @type {any} */ (silentSocket());

    expect(countTimers(() => client._tickHeartbeat()).armed).toBe(1);
    // The client clears the window the same way the adapter does.
    client._heartbeatDeadline = /** @type {any} */ (setTimeout(() => {}, 10_000));
    client._clearTimers();
    expect(client._heartbeatDeadline).toBeNull();
    expect(countTimers(() => client._tickHeartbeat()).armed).toBe(1);
  });
});
