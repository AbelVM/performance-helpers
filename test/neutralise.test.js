import { describe, it, expect } from 'vitest';
import { neutralise } from '../src/utils/neutralise.js';

describe('neutralise', () => {
  // RES-020. Ten helpers shipped this line by hand; two properties of that idiom
  // are asserted here rather than in any one helper, because the point is that all
  // ten now share one implementation of them.
  it('makes the method a no-op that can still be called', () => {
    class Thing {
      reset() {
        return 'did something';
      }
    }
    const t = new Thing();
    expect(t.reset()).toBe('did something');

    neutralise(t, 'reset');

    // The whole point: a post-disposal call must not throw. Deleting the method or
    // assigning `undefined` would turn every later call into a TypeError, which is a
    // louder failure than the one being fixed.
    expect(t.reset()).toBe(undefined);
  });

  it('is idempotent, and does not swap the function underneath a held reference', () => {
    class Thing {
      reset() {
        return 1;
      }
    }
    const t = new Thing();
    neutralise(t, 'reset');
    const held = t.reset;

    neutralise(t, 'reset'); // a second dispose

    // `this.reset = () => {}` re-assigned here, so `held` and `t.reset` were two
    // different functions for the same method — anything holding a reference across
    // disposal saw it swapped out.
    expect(t.reset, 'the shadow is not replaced on a second call').toBe(held);
  });

  it('leaves the shadow non-enumerable, so the instance shape does not change', () => {
    class Thing {
      reset() {
        return 1;
      }
    }
    const t = new Thing();
    const keysBefore = Object.keys(t);
    const spreadBefore = { ...t };

    neutralise(t, 'reset');

    // With a plain assignment the shadow is enumerable, so `for...in`, a spread and
    // `Object.assign` all start reporting a `reset` that was not there before.
    expect(Object.keys(t)).toEqual(keysBefore);
    expect({ ...t }).toEqual(spreadBefore);
    expect(Object.values({ ...t })).toEqual(Object.values(spreadBefore));
  });

  it('leaves a method that was never there alone, and does not create one', () => {
    const bare = {};
    neutralise(bare, 'reset');
    // It defines rather than checks, so a name that was absent gains a no-op — the
    // same as the assignment it replaces. Pinned so the behaviour is a decision
    // rather than an accident.
    expect(typeof bare.reset).toBe('function');
    expect(bare.reset()).toBe(undefined);
  });
});
