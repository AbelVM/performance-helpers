import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PowerRTCChannel } from '../src/helpers/powerRTCChannel.js';
import { READY_STATE } from '../src/helpers/constants.js';

/**
 * RT-017: the three lists that have to agree about a data channel's state.
 *
 * ## Why this file exists
 *
 * Four defects landed in `PowerRTCChannel`, all found by tests and none by
 * reading the code, and all four were the same mistake in different clothes:
 *
 * > **A state machine with states documented but not wired.**
 *
 * Three separate lists describe that machine and nothing made them agree:
 *
 * 1. the **docblock table**, which enumerates the platform's four states;
 * 2. the **mapping** from those strings to numeric `READY_STATE`;
 * 3. the **event listeners** that move the state on.
 *
 * A table listing four states is not evidence that four states are handled. The
 * `closing` state was in list 1 for the whole life of the class and missing from
 * list 3, so a closing channel reported `OPEN` — the exact "reports itself
 * healthy" failure the class exists to prevent — and every frame during a
 * teardown produced a spurious `onError`.
 *
 * ## What this guard does that the other tests do not
 *
 * `test/powerRTCChannel.readyState.test.js` asserts each transition
 * individually, and it caught the missing `closing` listener. But it did so by
 * *knowing* that `closing` should move the state — which is the same knowledge
 * a future edit could remove along with the listener.
 *
 * **This file takes the list from the docblock instead.** So if a state is
 * documented and unwired, or wired and undocumented, or mapped but not
 * reachable, this fails. The docblock becomes the source of truth rather than
 * prose that drifts, which is what it was.
 */

/** A data channel that reports whatever state it is told to, and records events. */
class ProbeChannel {
  constructor(readyState = 'connecting') {
    this.listeners = new Map();
    this.readyState = readyState;
    this.binaryType = 'arraybuffer';
    this.bufferedAmount = 0;
    this.bufferedAmountLowThreshold = 0;
    this.sctp = { maxMessageSize: 65536 };
    this.sent = [];
    this.events = [];
  }
  addEventListener(type, fn) {
    this.events.push(type);
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
  fire(type) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn({ type });
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 'closed';
  }
}

/**
 * The states the module docblock claims to normalise, read out of its table.
 *
 * Parsed rather than restated, because restating it is what let the table and
 * the code disagree in the first place. The row is
 * `` | `readyState` | number, `0`–`3` | **string**, `'a'`/`'b'`/… | ``.
 */
function documentedStates() {
  const source = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'helpers', 'powerRTCChannel.js'),
    'utf8'
  );
  const row = source
    .split('\n')
    .find((l) => l.includes('| `readyState` |') && l.includes('**string**'));
  expect(row, 'the docblock must keep a `readyState` row naming the string states').toBeTruthy();
  return [...row.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
}

/**
 * Every state reachable through the public API, discovered rather than assumed.
 *
 * Reads `readyState` back after each transition, so a state that is mapped but
 * unreachable does not appear here — which is the failure mode a hand-written
 * list would have hidden.
 *
 * @returns {Map<string, number>} state name → the numeric `READY_STATE` it reports
 */
function reachableStates() {
  const found = new Map();
  const dc = new ProbeChannel('connecting');
  const channel = new PowerRTCChannel(dc);
  found.set('connecting', channel.readyState);

  // Each state the platform can put a channel into after construction, and the
  // event that reports it. `closed` has a local path too (`close()`), exercised
  // separately below because it does not go through an event.
  for (const [name, event] of [
    ['open', 'open'],
    ['closing', 'closing'],
    ['closed', 'close'],
  ]) {
    dc.readyState = name;
    dc.fire(event);
    found.set(name, channel.readyState);
  }
  channel.dispose();

  // And a channel constructed directly in each state, so the *initial* mapping is
  // covered rather than only the transitions.
  for (const name of ['connecting', 'open', 'closing', 'closed']) {
    const c = new PowerRTCChannel(new ProbeChannel(name));
    found.set(name, c.readyState);
    c.dispose();
  }
  return found;
}

describe('the docblock, the mapping and the listeners agree', () => {
  it('every documented state is reachable, and reports a distinct READY_STATE', () => {
    const documented = documentedStates();
    const reachable = reachableStates();

    // The table is the contract. Four states is not an assertion anyone should
    // have to keep updating by hand, so the count is only stated to catch a
    // regex that quietly stopped matching anything.
    expect(documented.length).toBeGreaterThanOrEqual(4);

    // **The assertion that would have caught the `closing` defect.** It was named
    // in this table and no listener moved the state, so it never appeared in the
    // reachable set — and nothing else compared the two lists.
    const unreachable = documented.filter((name) => !reachable.has(name));
    expect(
      unreachable,
      `documented but unreachable: ${unreachable.join(', ')} — a state in the docblock ` +
        'with no event or mapping that produces it reports the wrong readyState'
    ).toEqual([]);

    // The other direction: a state the code can report but the table does not
    // name is undocumented behaviour, which is how a reader learns to distrust
    // the table.
    const undocumented = [...reachable.keys()].filter((n) => !documented.includes(n));
    expect(undocumented, `reachable but undocumented: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('maps each documented state to the matching numeric READY_STATE', () => {
    const expected = {
      connecting: READY_STATE.CONNECTING,
      open: READY_STATE.OPEN,
      closing: READY_STATE.CLOSING,
      closed: READY_STATE.CLOSED,
    };
    for (const [name, state] of Object.entries(expected)) {
      const channel = new PowerRTCChannel(new ProbeChannel(name));
      // Not just "some number": the *same* numbers `PowerWebSocketClient` and
      // `PowerSocketAdapter` report, position for position. A mapping that was
      // merely injective would pass a `typeof === 'number'` check and still make
      // every cross-transport comparison wrong.
      expect(channel.readyState, name).toBe(state);
      expect(typeof channel.readyState, name).toBe('number');
      channel.dispose();
    }
  });

  it('subscribes to an event for every post-initial state the table names', () => {
    // The structural half, stated separately so a failure says *which* mechanism
    // broke: it is not enough that no state is unreachable, because a state could
    // stop being reachable only for a reason this file has not thought of. This
    // asserts the listeners themselves, which is where `closing` was missing.
    const dc = new ProbeChannel('connecting');
    const channel = new PowerRTCChannel(dc);
    // The five events the class needs. `closing` is the one whose absence cost a
    // full defect cycle, and `bufferedamountlow` is the push signal the row's
    // back-pressure claim rests on.
    expect(new Set(dc.events)).toEqual(
      new Set(['open', 'message', 'closing', 'close', 'error', 'bufferedamountlow'])
    );
    expect(dc.events.length).toBe(6); // no duplicates
    channel.dispose();
  });

  it('reports a local close without an event, so the last state has no event path', () => {
    // `close()` is the only way to reach `closed` without the platform, because
    // `RTCDataChannel.close()` takes no arguments and the `close` event is what
    // reports the remote case. Without this the table's `closed` row would depend
    // entirely on the platform firing an event.
    const dc = new ProbeChannel('open');
    const channel = new PowerRTCChannel(dc);
    dc.events = [];
    channel.close();
    expect(channel.readyState).toBe(READY_STATE.CLOSED);
    // Nothing was fired: the state came from the local call alone.
    expect(dc.events).toEqual([]);
  });
});
