/**
 * A `WebSocketStream` that is not yet open was permanently deaf.
 *
 * `_pumpStream` read `socket.readable` **once** and returned if it was not a
 * `ReadableStream`. A `WebSocketStream` reports `readable: null` until its
 * connection opens, so the pump gave up before there was anything to read and
 * nothing ever re-armed it. The adapter's own state was indistinguishable from
 * health: `backpressureMode` reported `'streams'`, `send()` returned `true`, and
 * not one inbound message was ever delivered. Measured before the fix: 0 of 1
 * messages, with the stream opened and the message pushed afterwards.
 *
 * This is the other half of RT-004. The `releaseLock()` half — a closed stream
 * staying locked — was fixed in the same row's earlier commit and is exercised in
 * `powerSocketAdapter.detect.test.js`; it is the *deafness* that is left.
 *
 * The wait is a **backing-off unref'd poll**, not an event. `WebSocketStream`
 * from `ws` emits `'open'`, but a browser `WebSocket` exposed as a stream may
 * not, and an object that merely gains a `readable` later certainly does not — an
 * event-based wait would fix the easy case and leave the rest. Polling costs
 * nothing when the stream is already readable, because the first attempt is
 * synchronous and the timer is only armed after it fails.
 *
 * Real `ReadableStream`/`WritableStream` throughout, so `getReader` and the
 * lock semantics are the platform's. Counts and timer state, never a duration:
 * the harness measures a ~28% median spread, and the assertions below are about
 * whether a message arrived and whether a timer was left armed.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerSocketAdapter } from '../src/helpers/powerSocketAdapter.js';

/**
 * A `WebSocketStream`-shaped object that is not readable until `open()`.
 *
 * `readable` is a plain `null` property before opening, which is what `ws`
 * reports, and a real `ReadableStream` after. The writable side is a real
 * `WritableStream` so the lock semantics the adapter depends on are real too.
 */
class NotYetOpenStream {
  constructor() {
    /** @type {any} */
    this.readable = null;
    this.writable = new WritableStream({ write: () => {} });
    this._controller = null;
  }
  open() {
    this.readable = new ReadableStream({
      start: (c) => {
        this._controller = c;
      },
    });
    return this;
  }
  push(value) {
    this._controller?.enqueue(value);
    return this;
  }
}

/** Resolve once every already-queued microtask and one macrotask turn has run. */
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the stream pump waits for a stream that is not open yet', () => {
  it('delivers a message that arrives after the stream opens', async () => {
    // The defect, in one assertion. Before the fix this was 0 with the stream
    // opened and the message pushed afterwards.
    const socket = new NotYetOpenStream();
    const seen = [];
    const adapter = new PowerSocketAdapter(socket, {
      kind: 'stream',
      onMessage: (m) => seen.push(m.data),
    });

    expect(seen).toEqual([]);

    socket.open().push('after-open');
    // Enough turns for the retry to fire and the reader to deliver. A bound on
    // waiting, not a claim about how long it takes.
    for (let i = 0; i < 12 && seen.length === 0; i += 1) await turn();

    expect(seen).toEqual(['after-open']);
    adapter.close();
  });

  it('reports a healthy-looking adapter the whole time it is waiting', async () => {
    // Why this was silent for so long: nothing observable says "not ready yet".
    // These are the properties a caller would check before concluding the
    // socket was healthy, and all of them were true.
    const socket = new NotYetOpenStream();
    const adapter = new PowerSocketAdapter(socket, { kind: 'stream' });

    expect(adapter.kind).toBe('stream');
    expect(adapter.isOpen).toBe(true);
    expect(adapter.send('early')).toBe(true);
    // The row's evidence was `backpressureMode` reporting `'streams'`, but
    // **no such property exists on `PowerSocketAdapter`** — it is a getter on
    // `PowerWebSocketClient` (`powerWebSocketClient.js:325`). The adapter's own
    // equivalents are `stats().kind` and a `bufferedAmount` of 0, and those are
    // what a caller would actually check. First written as
    // `stats().backpressureMode` and it read `undefined`.
    expect(adapter.stats().kind).toBe('stream');
    expect(adapter.bufferedAmount).toBe(0);
    expect(adapter.stats().canPing).toBe(false);

    socket.open().push('late');
    const seen = [];
    adapter._onMessage = (m) => seen.push(m.data);
    for (let i = 0; i < 12 && seen.length === 0; i += 1) await turn();

    // A message sent *before* the stream was readable is not lost either.
    expect(seen).toEqual(['late']);
    adapter.close();
  });

  it('reads a stream that is already open on the first attempt, with no timer', async () => {
    // The polling must cost nothing on the ordinary path. If a timer were armed
    // before the first synchronous attempt, every healthy stream adapter would
    // schedule work it never needs.
    const socket = new NotYetOpenStream().open();
    const seen = [];
    const adapter = new PowerSocketAdapter(socket, {
      kind: 'stream',
      onMessage: (m) => seen.push(m.data),
    });

    expect(adapter._streamRetryTimer).toBeNull();
    // The first delay is the floor: nothing was armed, so nothing backed off.
    expect(adapter._streamRetryDelay).toBe(5);

    socket.push('first');
    for (let i = 0; i < 12 && seen.length === 0; i += 1) await turn();

    expect(seen).toEqual(['first']);
    expect(adapter._streamRetryTimer).toBeNull();
    adapter.close();
  });

  it('backs off rather than polling at a fixed short interval', async () => {
    // The failure mode of this design is a stream that never opens polling
    // forever. The delay has to grow, or that costs 100+ wakeups a second for
    // as long as the socket lives. Observed through the delay itself, not by
    // timing anything.
    // Installed **before** construction. The first draft switched them on
    // afterwards, by which point `_attachStream` had already armed a real 5 ms
    // timer that fake timers cannot step, so nothing ever fired and the observed
    // "backoff" was a delay that never grew past its first doubling.
    vi.useFakeTimers();
    const socket = new NotYetOpenStream();
    const adapter = new PowerSocketAdapter(socket, { kind: 'stream' });

    // Read after construction, because the **first** arming already happened
    // synchronously inside `_attachStream` -> `_pumpStream`, and the delay is
    // doubled as it arms.
    const delays = [adapter._streamRetryDelay];
    // Fake timers, and this is the one test in the file that needs them. The
    // first draft awaited a 0 ms turn per sample, which does not advance the
    // wall clock far enough for a 10 ms timer to fire, so it observed two
    // distinct delays and asserted on a schedule that had barely started.
    // Stepping the clock is not a duration assertion — nothing here claims how
    // long anything takes, only what delay the next attempt is scheduled at.
    try {
      for (let i = 0; i < 8; i += 1) {
        const pending = adapter._streamRetryDelay;
        await vi.advanceTimersByTimeAsync(pending);
        delays.push(adapter._streamRetryDelay);
      }
    } finally {
      vi.useRealTimers();
    }
    // Growing, then capped: a stream that never opens must not cost 100+
    // wakeups a second for as long as the socket lives.
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i], `delay shrank at index ${i}: ${delays.join(',')}`).toBeGreaterThanOrEqual(
        delays[i - 1]
      );
    }
    expect(Math.max(...delays)).toBe(250);
    expect(new Set(delays).size).toBeGreaterThan(3);

    adapter.close();
  });

  it('stops waiting once the adapter is closed', async () => {
    // Nothing else re-arms the retry, so a timer left armed here would sit
    // re-checking `readable` on a socket the adapter has finished with.
    const socket = new NotYetOpenStream();
    const adapter = new PowerSocketAdapter(socket, { kind: 'stream' });

    await turn();
    expect(adapter._streamRetryTimer).not.toBeNull();

    adapter.close();
    expect(adapter._streamRetryTimer).toBeNull();

    // And it stays stopped: opening the stream afterwards delivers nothing,
    // because the adapter is closed. Which is correct — it was closed.
    socket.open().push('too-late');
    const seen = [];
    adapter._onMessage = (m) => seen.push(m.data);
    for (let i = 0; i < 6; i += 1) await turn();
    expect(seen).toEqual([]);
  });

  it('stops waiting once disposed, and dispose is safe to repeat', async () => {
    const socket = new NotYetOpenStream();
    const adapter = new PowerSocketAdapter(socket, { kind: 'stream' });

    await turn();
    expect(adapter._streamRetryTimer).not.toBeNull();

    expect(() => {
      adapter.dispose();
      adapter[Symbol.dispose]();
    }).not.toThrow();
    expect(adapter._streamRetryTimer).toBeNull();
  });

  it('does not wait at all on a socket that is not a stream', async () => {
    // The guard the arming method has to keep: `kind` can be forced, so a
    // `ws` socket driven as a stream has no `readable` and must not be polled
    // for one. A poll here would be an endless wait on an object that will
    // never have the property.
    const wsLike = { on: () => {}, send: () => {} };
    const adapter = new PowerSocketAdapter(wsLike, { kind: 'stream' });

    await turn();
    // One attempt, no reader, and no timer left behind by a stream that cannot
    // become one — the pump cannot distinguish "not yet" from "never", so this
    // is the documented cost of forcing the kind.
    expect(adapter._streamReader).toBeNull();
    adapter.close();
  });
});
