import { describe, it, expect } from 'vitest';
import PowerCircuit from '../src/helpers/powerCircuit.js';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

/**
 * How long the circuit stays open before allowing a half-open trial.
 *
 * The two waits below must be derived from this rather than written as literals.
 * A 10 ms timeout with a literal 15 ms wait is a 5 ms margin, and when the
 * machine is busy the reopen timer has not fired by the time the next `call()`
 * runs - so the call throws `CircuitOpen` instead of transitioning, and the test
 * fails for reasons that have nothing to do with the code. One of these failed
 * exactly that way, once, under load.
 *
 * Widening the timeout *without* widening the waits is the same bug in the other
 * direction, and is what a first attempt at this fix did: it made two of the
 * three tests fail deterministically, because the circuit could then never
 * reach half-open within the literal wait.
 *
 * **So the timeout is now 1 000 ms and the waits move with it**, which is what
 * the note above asks for and what the previous value did not do. The `x10`
 * relationship is replaced by `+ 200` because with a 1 000 ms timeout a `x10`
 * wait would sleep 10 seconds in each of the two tests that need one. `+ 200`
 * keeps the property the tests actually depend on — *past* the timeout, so the
 * reopen timer has fired — at a cost of 1.2 s each.
 *
 * The flake was not hypothetical when this was written: `powerCircuit` failed
 * this assertion under full-suite load at least twice in one session, reading
 * `half-open` where `open` was expected, because the `await` before the
 * assertion exceeded a 10 ms window. It passed in isolation every time, which is
 * the signature of a load-sensitive test rather than a wrong one.
 */
const TIMEOUT_MS = 1_000;

/** Past {@link TIMEOUT_MS}, so the reopen timer has fired. */
const PAST_TIMEOUT_MS = TIMEOUT_MS + 200;

describe('PowerCircuit observability', () => {
  it('calls onStateChange callback when state transitions occur', async () => {
    const calls = [];
    const cb = new PowerCircuit({
      threshold: 1,
      timeout: TIMEOUT_MS,
      onStateChange: (s, r) => calls.push([s, r]),
    });

    // cause a failure to open the circuit
    await cb.call(() => Promise.reject(new Error('fail'))).catch(() => {});

    // after one failure threshold=1 -> should open
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0][0]).toBe('open');
    expect(calls[0][1]).toBe('thresholdExceeded');

    // advance past the timeout so the next call is allowed a half-open trial
    await new Promise((res) => setTimeout(res, PAST_TIMEOUT_MS));

    // next call should cause half-open then success -> closed
    await cb.call(() => Promise.resolve('ok'));

    // find closed event
    const closed = calls.find(([s]) => s === 'closed');
    expect(closed).toBeTruthy();
  });

  it('swallows errors thrown by onStateChange and event bus observers', async () => {
    const bus = new PowerEventBus();
    bus.on('stateChange', () => {
      throw new Error('bus observer failed');
    });

    const cb = new PowerCircuit({
      threshold: 1,
      timeout: TIMEOUT_MS,
      eventBus: bus,
      onStateChange() {
        throw new Error('callback failed');
      },
    });

    await expect(cb.call(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.state).toBe('open');
  });

  it('emits stateChange on provided PowerEventBus', async () => {
    const bus = new PowerEventBus();
    const events = [];
    bus.on('stateChange', (payload) => events.push(payload));

    const cb = new PowerCircuit({ threshold: 1, timeout: TIMEOUT_MS, eventBus: bus });

    await cb.call(() => Promise.reject(new Error('boom'))).catch(() => {});

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].state).toBe('open');
    expect(events[0].reason).toBe('thresholdExceeded');

    await new Promise((res) => setTimeout(res, PAST_TIMEOUT_MS));
    await cb.call(() => Promise.resolve('ok'));

    const closedEvent = events.find((e) => e.state === 'closed');
    expect(closedEvent).toBeTruthy();
  });
});
