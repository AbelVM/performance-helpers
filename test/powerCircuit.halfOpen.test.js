/**
 * RES-025: half-open was never observable.
 *
 * `PowerCircuit`'s `state` getter computes `'half-open'` **logically** — when
 * `_state` is `'open'` and the drawn window has elapsed, the getter returns
 * `'half-open'` without mutating anything. That lazy design is correct: an eager
 * transition would need a timer, which is a wakeup and a handle to leak.
 *
 * But `_setState` was the *only* thing that notified `onStateChange` or emitted
 * `stateChange` on the bus, and the getter does not go through it. So a breaker
 * reported `half-open` to anyone who read `state` while telling nobody, and a
 * breaker whose trial then succeeded went `open -> closed` for every observer
 * with nothing in between. Any dashboard built on the bus was wrong.
 *
 * The transition is now announced from the getter, once per outage. Reading
 * `state` is what a dashboard does to notice, so the observer that polls is the
 * one that gets told.
 *
 * The mechanism is a `_halfOpenAnnounced` flag, because the getter can observe
 * the window elapsing any number of times before a call is attempted and
 * `_setState` runs. Without it the event would fire on every poll.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

/**
 * Trip the breaker, then wait out its window.
 *
 * The window is drawn per trip from `timeout`, so the wait uses the drawn value
 * rather than the base — doubling means a test that waited `timeout` would
 * sometimes not have elapsed, which is a flake that looks like a missing event.
 *
 * @param {PowerCircuit} circuit
 */
async function tripAndWaitOut(circuit) {
  // `call(fn)` is the entry point and returns a promise, so a rejection is the
  // way a trip is expressed. First written as `execute(fn)` with a synchronous
  // throw, which is not this class's API at all.
  const attempt = () => circuit.call(() => Promise.reject(new Error('upstream down')));
  for (let i = 0; i < THRESHOLD; i += 1) {
    await attempt().catch(() => {});
  }
  // The **internal** `_state`, not the `state` getter, and that distinction is the
  // fix for FLAKE-001.
  //
  // `state` computes `'half-open'` *logically* the moment the drawn window has
  // elapsed, so asserting `'open'` through it is a wall-clock assertion about a
  // 10 ms window. Under load the awaits above take longer than the window, the
  // getter reports `'half-open'`, and **6 of the 7 tests in this file fail** — the
  // row recorded one of them. Reproduced deterministically by blocking 60 ms
  // between the trip and this line, which fails every test that calls this helper.
  //
  // `_state` is what the precondition actually means — "the breaker tripped" — and
  // no amount of elapsed time can change it.
  //
  // Reading the getter here was also doing active damage: that read is itself the
  // announcement, so on a slow run it fired `'half-open'` before the test had set up
  // its expectation, and the first assertion in every test below
  // (`not.toContain('half-open')`) then failed for a reason that has nothing to do
  // with the event it is checking.
  expect(circuit._state).toBe('open');
  // The drawn window, plus a margin so the elapsed comparison has definitely
  // crossed. This is a wait for a state to exist, not a duration assertion.
  const window = circuit._openWindowMs;
  await new Promise((resolve) => setTimeout(resolve, window + 20));
}

/** One failure is enough to trip; the window is what this file is about. */
const THRESHOLD = 1;

describe('RES-025: the logical open -> half-open transition is announced', () => {
  it('emits stateChange when the drawn window elapses', async () => {
    // The defect: this event never fired. The breaker went open -> closed for
    // every observer, so a dashboard could never show "half-open".
    const bus = new PowerEventBus();
    /** @type {any[]} */
    const events = [];
    bus.on('stateChange', (payload) => events.push(payload));
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10, eventBus: bus });

    await tripAndWaitOut(circuit);
    expect(events.map((e) => e.state)).not.toContain('half-open');

    // Reading `state` is the observation, and the observation is the announcement.
    expect(circuit.state).toBe('half-open');

    const announced = events.filter((e) => e.state === 'half-open');
    expect(announced).toHaveLength(1);
    // With the reason, so a listener can tell this from a trial that was
    // actually attempted.
    expect(announced[0].reason).toBe('timeoutElapsed');
  });

  it('calls onStateChange for the same transition', async () => {
    const onStateChange = vi.fn();
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10, onStateChange });

    await tripAndWaitOut(circuit);
    onStateChange.mockClear();
    expect(circuit.state).toBe('half-open');

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('half-open', 'timeoutElapsed');
  });

  it('announces once, not on every read', async () => {
    // Without the once-flag the getter would fire the event on each poll, and a
    // dashboard polling every second would report a state change every second.
    const onStateChange = vi.fn();
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10, onStateChange });

    await tripAndWaitOut(circuit);
    onStateChange.mockClear();

    for (let i = 0; i < 20; i += 1) expect(circuit.state).toBe('half-open');

    expect(onStateChange).toHaveBeenCalledTimes(1);
  });

  it('does not announce before the window has elapsed', async () => {
    // The counterpart, and the reason the flag is not simply "announced on open".
    const onStateChange = vi.fn();
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10_000, onStateChange });

    for (let i = 0; i < THRESHOLD; i += 1) {
      await circuit.call(() => Promise.reject(new Error('down'))).catch(() => {});
    }
    onStateChange.mockClear();

    // Well inside the window, so nothing is due yet.
    expect(circuit.state).toBe('open');
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('does not mutate _state, so the lazy design is preserved', async () => {
    // The fix must not have quietly become an eager transition. `_state` stays
    // `'open'` until a call is attempted; only the *announcement* was added. A
    // version that called `_setState` from the getter would have passed every
    // assertion above and changed the timing of the trial path as a side effect.
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10 });
    await tripAndWaitOut(circuit);

    expect(circuit.state).toBe('half-open');
    expect(circuit._state).toBe('open');
    // The counter is untouched too: a logical half-open is the same outage.
    expect(circuit._consecutiveOpens).toBe(1);
  });

  it('survives an event bus that throws', async () => {
    // The announcement now runs inside a getter, so a throwing bus would
    // otherwise make reading `state` throw. The bus emit is guarded for that
    // reason; `_setState` did not guard it before, which was survivable only
    // because it never ran during a read.
    const bus = new PowerEventBus();
    bus.emit = () => {
      throw new Error('bus is broken');
    };
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10, eventBus: bus });

    await tripAndWaitOut(circuit);
    expect(() => circuit.state).not.toThrow();
    expect(circuit.state).toBe('half-open');
  });

  it('announces again for a new outage', async () => {
    // The flag is per-outage. If it were set once for the lifetime of the
    // instance, a second outage would go unannounced and the bug would return
    // after the first fix.
    const onStateChange = vi.fn();
    const circuit = new PowerCircuit({ threshold: 1, timeout: 10, onStateChange });

    await tripAndWaitOut(circuit);
    expect(circuit.state).toBe('half-open');

    // Close it, then trip it again.
    await circuit.call(() => Promise.resolve('recovered'));
    expect(circuit.state).toBe('closed');
    onStateChange.mockClear();

    for (let i = 0; i < THRESHOLD; i += 1) {
      await circuit.call(() => Promise.reject(new Error('down again'))).catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, circuit._openWindowMs + 20));
    expect(circuit.state).toBe('half-open');
    expect(onStateChange).toHaveBeenCalledWith('half-open', 'timeoutElapsed');
  });
});
