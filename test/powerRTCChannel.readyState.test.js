import { describe, it, expect, vi } from 'vitest';
import { PowerRTCChannel } from '../src/helpers/powerRTCChannel.js';
import { READY_STATE } from '../src/helpers/constants.js';

/**
 * RT-017: `RTCDataChannel.readyState` is a **string**, not the numeric
 * `READY_STATE` every other transport in this library reports.
 *
 * ## Why this file exists at all
 *
 * `READY_STATE.OPEN` is `1`. A data channel's `readyState` is `'open'`. So the
 * one line every caller in this library writes —
 *
 * ```js
 * if (channel.readyState === READY_STATE.OPEN) { … }
 * ```
 *
 * — is **false on a perfectly healthy, open channel**. No throw, no warning, no
 * error anywhere. The `===` against a number is where the failure goes, and the
 * consequence is the review's worst category: a silent total failure reported as
 * a healthy connection. A hub wired to it refuses every frame, and `stats()`
 * reports a channel that is connected, open, and has never sent anything.
 *
 * That is not hypothetical in this repository's own terms — it is the shape of
 * GAP-001 (a condition handled in a `catch` that could never be reached) and of
 * RT-014's shared validation gate: a branch that matches nothing still looks
 * like a branch.
 *
 * The first test below therefore asserts the *naive* comparison is false, so
 * that the rest of the file cannot be satisfied by an implementation that forgot
 * to normalise. If that assertion ever starts failing, `readyState` stopped being
 * a string and the normalisation this class exists for became dead code.
 */
class StringStateChannel {
  constructor(readyState = 'open') {
    this.listeners = new Map();
    this.readyState = readyState;
    this.sent = [];
    this.closeCalls = 0;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list)
      this.listeners.set(
        type,
        list.filter((f) => f !== fn)
      );
  }
  fire(type, event) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 'closed';
  }
  /**
   * A **detached** channel: one transferred to another realm, where the thread
   * that created it can no longer touch it. Getting `readyState` throws
   * `InvalidStateError`, which is why this class exists in a file about reading
   * that property once.
   */
  get readyStateThrows() {
    return this._detached;
  }
}

describe('the string readyState is what makes this class necessary', () => {
  it('the naive comparison against READY_STATE.OPEN is false on an open channel', () => {
    const dc = new StringStateChannel('open');
    // Stated first, and asserted as a *fact about the platform*, so the
    // normalisation below cannot be deleted on the grounds that it was unnecessary.
    expect(dc.readyState).toBe('open');
    expect(dc.readyState === READY_STATE.OPEN).toBe(false);
    expect(typeof READY_STATE.OPEN).toBe('number');

    // And this is the bug it produces, end to end: a guard written the obvious
    // way refuses every frame on a healthy channel. Asserted on the *double*'s
    // own `sent`, because the frame never leaves — a counter incremented inside
    // the untaken branch would read 0 either way and prove nothing.
    if (dc.readyState === READY_STATE.OPEN) dc.send(new Uint8Array(4));
    expect(dc.sent).toEqual([]);
  });

  it('normalises all four states to the numbers the library shares', () => {
    const cases = [
      ['connecting', READY_STATE.CONNECTING],
      ['open', READY_STATE.OPEN],
      ['closing', READY_STATE.CLOSING],
      ['closed', READY_STATE.CLOSED],
    ];
    for (const [name, expected] of cases) {
      const channel = new PowerRTCChannel(new StringStateChannel(name));
      expect(channel.readyState, `${name}`).toBe(expected);
      expect(typeof channel.readyState).toBe('number');
      expect(channel.isOpen).toBe(expected === READY_STATE.OPEN);
      channel.dispose();
    }
  });

  it('is a drop-in for the guard every other transport satisfies', () => {
    // The assertion that matters: the same line works against all three helpers,
    // which is the entire promise of an adapter.
    const channel = new PowerRTCChannel(new StringStateChannel('open'));
    expect(channel.readyState === READY_STATE.OPEN).toBe(true);
    expect(channel.isOpen).toBe(true);
    expect(channel.send(new Uint8Array(4))).toBe(true);
  });
});

describe('maintaining the state from events rather than re-reading it', () => {
  it('follows connecting -> open -> closing -> closed', () => {
    const dc = new StringStateChannel('connecting');
    const channel = new PowerRTCChannel(dc);
    expect(channel.readyState).toBe(READY_STATE.CONNECTING);

    for (const [event, state] of [
      ['open', READY_STATE.OPEN],
      ['closing', READY_STATE.CLOSING],
      ['close', READY_STATE.CLOSED],
    ]) {
      dc.readyState = event;
      dc.fire(event, { type: event });
      expect(channel.readyState, event).toBe(state);
    }
  });

  it('does not resurrect a closed channel when an open event arrives late', () => {
    // **A real defect, found by the property test in
    // `powerRTCChannel.test.js`** and pinned here so it cannot come back under a
    // narrower test. Firing `close` then `open` set the state back to open, so a
    // second `close` incremented `stats().closed` to 2 for one closure — and a
    // peer table that tears down an entry on `closed` would double-free.
    //
    // `close` is terminal for a data channel: there is no reopen path, and a
    // transport that recovers produces a *new* channel. An `open` after `close`
    // is a late delivery, not a transition.
    const onOpen = vi.fn();
    const dc = new StringStateChannel('open');
    const channel = new PowerRTCChannel(dc, { onOpen });
    expect(onOpen).toHaveBeenCalledTimes(1); // the already-open report

    dc.fire('close', { type: 'close' });
    dc.fire('open', { type: 'open' });
    expect(channel.readyState).toBe(READY_STATE.CLOSED);
    expect(channel.isOpen).toBe(false);
    // Neither counter moved: one closure, one report of open.
    expect(channel.stats()).toMatchObject({ opened: 1, closed: 1 });
    expect(onOpen).toHaveBeenCalledTimes(1);

    dc.fire('close', { type: 'close' });
    expect(channel.stats().closed).toBe(1);
  });

  it('never re-reads the platform property, so a detached channel cannot throw', () => {
    // **The requirement, not an optimisation.** Getting `readyState` on a
    // detached channel throws `InvalidStateError`, and a transferred channel is
    // exactly what this class is meant to serve — so a per-call read would throw
    // from `isOpen`, which is the one property a producer reads in a loop.
    const dc = new StringStateChannel('open');
    const channel = new PowerRTCChannel(dc);
    let reads = 0;
    Object.defineProperty(dc, 'readyState', {
      get() {
        reads += 1;
        throw new Error('InvalidStateError: channel is detached');
      },
      configurable: true,
    });
    // Every one of these would throw if the implementation read the platform.
    expect(channel.isOpen).toBe(true);
    expect(channel.readyState).toBe(READY_STATE.OPEN);
    expect(channel.bufferedAmount).toBe(0);
    expect(() => channel.send(new Uint8Array(4))).not.toThrow();
    expect(channel.stats().state).toBe(READY_STATE.OPEN);
    expect(reads).toBe(0);
  });

  it('constructs a detached channel rather than throwing, and treats it as not open', () => {
    const dc = new StringStateChannel('open');
    const onError = vi.fn();
    Object.defineProperty(dc, 'readyState', {
      get() {
        throw new Error('InvalidStateError: channel is detached');
      },
      configurable: true,
    });
    // The read is guarded at construction, because the case a caller is most
    // likely to hit — a channel transferred mid-negotiation — must not be the
    // case that cannot be adapted at all. `CONNECTING` is the only honest
    // statement available: whatever it is, it is not open.
    const channel = new PowerRTCChannel(dc, { onError });
    expect(channel.readyState).toBe(READY_STATE.CONNECTING);
    expect(channel.isOpen).toBe(false);
    expect(channel.send(new Uint8Array(4))).toBe(false);
    // The refusal is counted, not reported as an error: nothing went wrong, the
    // handshake is simply not finished.
    expect(onError).not.toHaveBeenCalled();
    expect(channel.stats().sendRefusals).toBe(1);
  });

  it('maps an unrecognised state to not-open, never to open', () => {
    // A new string in a future spec revision must fail **closed**. Mapping it to
    // `OPEN` would defeat the guard; mapping it to `CLOSED` would additionally
    // fire the teardown paths on a channel that is alive.
    const channel = new PowerRTCChannel(new StringStateChannel('unstable'));
    expect(channel.readyState).toBe(READY_STATE.CLOSING);
    expect(channel.isOpen).toBe(false);
    expect(channel.send(new Uint8Array(4))).toBe(false);
  });
});
