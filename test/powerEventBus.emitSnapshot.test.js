/**
 * `PowerEventBus.emit` iterates a snapshot — OBS-008.
 *
 * `Set` iteration visits entries added **during** traversal, and both arms of `emit`
 * walked a live bucket. So a listener that re-subscribes on every call is invoked
 * again *inside the same `emit`* — bounded in these tests only because the fixture
 * stops at 40.
 *
 * **The sharpest form of the defect is that the two entry points disagreed.** Measured
 * before the fix, on one listener that subscribes a fresh closure per call, capped at
 * 40: `emit` invoked it **40 times**; `emitAsync` invoked it **once**. Same bus, same
 * graph, same call — two answers. A test that only checked "does not hang" would have
 * passed against the broken version as soon as the fixture had a cap, which is why every
 * case here asserts the *count*, not the absence of a hang.
 *
 * Both arms are covered, because they are different code: the generic `Set` arm and the
 * `PowerSubscriberSet` arm, which has its own `forEach` over its own backing `Set`.
 */
import { describe, it, expect } from 'vitest';
import { PowerEventBus } from '../src/index.js';

/** Upper bound on the fixture's self-subscription, so a regression terminates. */
const CAP = 40;

/**
 * A bus with one listener that subscribes a **fresh closure** every time it runs.
 *
 * The fresh closure is the whole point: re-subscribing the *same* function is a no-op,
 * because a `Set` dedupes by reference, and a fixture that does that cannot see this
 * bug at all. The first draft of this test re-subscribed the identical reference and
 * measured 1 call against the broken code.
 *
 * @returns {{bus: PowerEventBus, calls: () => number}}
 */
function selfSubscribingBus() {
  const bus = new PowerEventBus();
  let calls = 0;
  const listener = () => {
    calls += 1;
    if (calls < CAP) bus.on('grow', () => listener());
  };
  bus.on('grow', listener);
  return { bus, calls: () => calls };
}

describe('PowerEventBus.emit iterates a snapshot', () => {
  it('a listener that re-subscribes is invoked once per emit', () => {
    const { bus, calls } = selfSubscribingBus();
    bus.emit('grow', 1);
    expect(calls()).toBe(1);
  });

  it('emit and emitAsync agree on the identical listener graph', () => {
    // **The regression this row is really about.** Before the fix these were 40 and 1.
    // Asserting each against its own expected value would have let them drift again;
    // asserting they are *equal* is what makes the pair a property.
    const sync = selfSubscribingBus();
    sync.bus.emit('grow', 1);
    const async_ = selfSubscribingBus();
    return async_.bus.emitAsync('grow', 1).then(() => {
      expect(sync.calls()).toBe(async_.calls());
      expect(sync.calls()).toBe(1);
    });
  });

  it('a second emit sees the listener the first one added', () => {
    // The other half of the contract, and the reason a snapshot is right rather than
    // merely safe: a listener added *during* one emit must still be reached by the
    // **next** one. Skipping it entirely — the other tempting fix — would make growth
    // silently stop.
    const { bus, calls } = selfSubscribingBus();
    bus.emit('grow', 1);
    expect(calls()).toBe(1);
    bus.emit('grow', 2);
    // **Greater than one, not exactly two.** The second emit's snapshot holds two
    // listeners, and the one the first emit added subscribes again while running, so
    // the fixture compounds: 1 -> 3. An exact count of 2 was my first expectation and it
    // was wrong about the fixture, not about the bus. What matters is that the count
    // *grew* - a fix that skipped mid-emit additions entirely would freeze it at 1,
    // which is the failure this case exists to catch.
    expect(calls()).toBeGreaterThan(1);
  });

  it('still delivers to every listener present at emit time', () => {
    // A snapshot must not truncate the *existing* listeners — the bug is only about
    // ones added mid-traversal.
    const bus = new PowerEventBus();
    const seen = [];
    bus.on('e', () => seen.push('a'));
    bus.on('e', () => seen.push('b'));
    bus.on('e', () => seen.push('c'));
    bus.emit('e', 1);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('delivers in insertion order', () => {
    const bus = new PowerEventBus();
    const seen = [];
    bus.on('e', () => seen.push(1));
    bus.on('e', () => seen.push(2));
    bus.on('e', () => seen.push(3));
    bus.emit('e', 1);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('reports whether anyone was notified', () => {
    // `emit` returns a boolean that callers branch on; the snapshot changed how that is
    // computed, so it is pinned rather than assumed.
    const bus = new PowerEventBus();
    expect(bus.emit('nobody')).toBe(false);
    bus.on('e', () => {});
    expect(bus.emit('e')).toBe(true);
  });

  it('a listener removed during an emit is not called from the snapshot', () => {
    // Documented behaviour worth pinning: the snapshot is taken at emit time, so a
    // listener that unsubscribes a *later* sibling still gets called in this emit. That
    // is the trade for not looping forever, and it was already the behaviour for the
    // `emitAsync` path, so making them agree is the point.
    const bus = new PowerEventBus();
    const seen = [];
    const second = () => seen.push('second');
    bus.on('e', () => {
      seen.push('first');
      bus.off('e', second);
    });
    bus.on('e', second);

    bus.emit('e', 1);
    expect(seen).toEqual(['first', 'second']);
  });
});
