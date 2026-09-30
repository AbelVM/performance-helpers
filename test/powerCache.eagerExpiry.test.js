/**
 * CACHE-008: `eagerCleanupOnRead` documented a behaviour the code always had.
 *
 * The option promised that `peek()` and `has()` would "remove expired nodes when
 * observed", and did nothing. The row recorded that as the defect, and it is —
 * but the measurement says the *documentation* was the actual error, and in the
 * opposite direction from what the row implies.
 *
 * `_fetchValidNode` already removes an expired node on **every** read path, with
 * no flag consulted: it unlinks, frees, counts `_expirations` and fires
 * `onExpire`. So the behaviour the option described was already unconditional,
 * setting it changed no observable result, and the guide's claim that "the
 * library currently defaults to non-mutating read behavior (expired entries remain
 * until cleanup)" was simply false.
 *
 * Measured with a controlled clock, both values of the option:
 *
 *     eagerCleanupOnRead=false | has: false | size 1->0 | expirations 0->1 | onExpire fired
 *     eagerCleanupOnRead=true  | has: false | size 1->0 | expirations 0->1 | onExpire fired
 *
 * Identical. So the option is removed, and the guide is corrected to describe what
 * the code does — a reader who believed the guide would be surprised to find
 * `onExpire` firing from a `has()`.
 *
 * The alternative to removal was implementing the option by *inverting* the
 * current behaviour to match the docs, which would mean making reads
 * non-mutating by default. That is a real behaviour change on a hot path, it
 * would stop `onExpire` firing from reads, and the code's behaviour is the one
 * with a helper written to produce it. So the code is right and the prose was not.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerCache } from '../src/helpers/powerCache.js';

/**
 * A cache with an injected clock, so expiry is reached by advancing time rather
 * than by sleeping. The option exists for exactly this.
 *
 * @param {Object} [options]
 */
function withClock(options = {}) {
  const state = { t: 1_000_000 };
  const onExpire = vi.fn();
  const cache = new PowerCache({
    maxEntries: 10,
    defaultTTL: 50,
    now: () => state.t,
    onExpire,
    ...options,
  });
  return {
    cache,
    onExpire,
    advance: (ms) => {
      state.t += ms;
    },
  };
}

describe('expiry is eager on every read path, with no option', () => {
  it('has() removes the expired entry it observes', () => {
    // The core claim, and the one the removed option used to imply was opt-in.
    const { cache, onExpire, advance } = withClock();
    cache.set('a', 1);
    expect(cache.size).toBe(1);

    advance(100); // past the 50 ms TTL
    expect(cache.has('a')).toBe(false);

    expect(cache.size).toBe(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire.mock.calls[0][0]).toBe('a');
    cache.dispose();
  });

  it('peek() removes it too, and get() as well', () => {
    // All three read paths share the node lookup, which is why the option could
    // not have been implemented as documented — there was nothing to switch on.
    for (const method of ['peek', 'has', 'get']) {
      const { cache, onExpire, advance } = withClock();
      cache.set('a', 1);
      advance(100);
      expect(cache[method]('a'), `${method} should not see an expired value`).toBeFalsy();
      expect(cache.size, `${method} should have removed the node`).toBe(0);
      expect(onExpire, `${method} should have fired onExpire`).toHaveBeenCalledTimes(1);
      cache.dispose();
    }
  });

  it('is not a property of the instance any more', () => {
    // The option is gone rather than inert. An inert field would leave a caller
    // able to set it and believe it did something, which is the original defect.
    const { cache } = withClock();
    expect('eagerCleanupOnRead' in cache).toBe(false);
    cache.dispose();
  });

  it('an unknown option is ignored rather than erroring', () => {
    // What happens to a caller who was already passing it — which is the only
    // population that could have been depending on it, and could not have been
    // depending on the behaviour, since the behaviour was unconditional.
    const { cache } = withClock({ eagerCleanupOnRead: true });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    cache.dispose();
  });

  it('a live entry is still not removed by a read', () => {
    // The counterpart, and the reason this is not simply "reads delete things".
    const { cache, onExpire, advance } = withClock();
    cache.set('a', 1);
    advance(10); // still inside the 50 ms TTL
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(1);
    expect(onExpire).not.toHaveBeenCalled();
    cache.dispose();
  });

  it('ignoreExpiry still reports an expired entry as present', () => {
    // The documented purpose of `ignoreExpiry`, and the one behaviour the guide
    // got right: a caller that wants to see expired entries asks for them, and
    // the expiry check is skipped rather than the node being resurrected.
    const { cache, advance } = withClock();
    cache.set('a', 1);
    advance(100);
    expect(cache.has('a', { ignoreExpiry: true })).toBe(true);
    cache.dispose();
  });
});
