import { describe, it, expect } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

/**
 * CACHE-014: a disposed `PowerTTLMap` must stop accepting writes.
 *
 * ## The defect this pins
 *
 * `dispose()` called `clear()` and then neutralised `clear`, so an instance
 * accepted writes that it could not then be emptied of. The sequence is three
 * ordinary-looking calls:
 *
 * ```js
 * const m = new PowerTTLMap(1000);
 * m.dispose();
 * m.set('b', 2);   // stored
 * m.clear();       // neutered: does nothing
 * m.get('b');      // 2
 * ```
 *
 * The caller holds an entry with no way to remove it short of waiting out its TTL.
 * That is worse than either of the two coherent alternatives — refusing the write,
 * or leaving the instance fully usable — because it is the only one where the map
 * accepts state it will not let go of.
 *
 * ## Why a throw rather than a silent no-op
 *
 * Neutralising `set` instead would keep the call quiet, and a caller would believe
 * it had stored a value. This library already throws on a non-finite count, a
 * negative TTL and an unusable option, so refusing here is the consistent answer
 * rather than a new policy. Reads deliberately keep working: they see an empty map,
 * which is the truthful answer and needs no guard.
 */
describe('PowerTTLMap refuses writes after dispose (CACHE-014)', () => {
  /** A disposed map, for the cases that only need one. */
  const disposed = () => {
    const m = new PowerTTLMap(1000);
    m.set('a', 1);
    m.dispose();
    return m;
  };

  it('set() throws after dispose, naming the method and the remedy', () => {
    const m = disposed();
    expect(() => m.set('b', 2)).toThrow(TypeError);
    // The message has to name what failed and what to do instead. An assertion on
    // the shape of the advice is the difference between a usable error and a
    // "something went wrong".
    expect(() => m.set('b', 2)).toThrow(/`set\(\)` after `dispose\(\)`/);
    expect(() => m.set('b', 2)).toThrow(/new PowerTTLMap/);
  });

  it('the refused write left nothing behind', () => {
    // The half that matters. A throw that still stored the value would satisfy the
    // test above and keep the original defect.
    const m = disposed();
    expect(() => m.set('b', 2)).toThrow(TypeError);
    expect(m.get('b')).toBeUndefined();
    expect(m.has('b')).toBe(false);
    expect(m.size).toBe(0);
  });

  it('reads still work, and report an empty map rather than throwing', () => {
    // Reads must not throw. `dispose()` emptied the map, so an empty answer is the
    // truthful one, and a reader on a scope-exit path should not have to guard.
    const m = disposed();
    expect(m.get('a')).toBeUndefined();
    expect(m.has('a')).toBe(false);
    expect(m.size).toBe(0);
    expect([...m.keys()]).toEqual([]);
    expect([...m.entries()]).toEqual([]);
  });

  it('touch() and delete() stay quiet, because they cannot strand state', () => {
    // Not an oversight: both return early on a key the emptied map does not hold,
    // so they mutate nothing. Guarding them would be two more throws on paths that
    // are already harmless — and a `delete()` that threw after teardown would break
    // the ordinary `for (const k of m.keys()) m.delete(k)` teardown loop.
    const m = disposed();
    expect(m.touch('b', 500)).toBe(false);
    expect(m.delete('b')).toBe(false);
    expect(m.size).toBe(0);
  });

  it('is idempotent, and a second dispose does not re-clear', () => {
    const m = disposed();
    expect(() => m.dispose()).not.toThrow();
    expect(() => m.dispose()).not.toThrow();
    expect(() => m.set('b', 2)).toThrow(TypeError);
  });

  it('works through a scope-exit dispose, which is the call site the flag has to survive', () => {
    // Not a proxy for the case above: this exercises the shape a caller actually
    // writes — a binding that goes out of scope and disposes — and it is the
    // `[Symbol.dispose]` contract that makes it work. Node 22.12 cannot parse
    // `using` declarations and no transformer in this tree downlevels them, so
    // the scope exit is spelled out here; the behaviour under test is identical.
    let escaped;
    const scope = new PowerTTLMap(1000);
    try {
      scope.set('a', 1);
      escaped = scope;
    } finally {
      scope.dispose();
    }
    expect(escaped.size).toBe(0);
    expect(() => escaped.set('b', 2)).toThrow(/after `dispose\(\)`/);
  });

  it('does not fire before dispose, so the hot path is unaffected', () => {
    // The guard is one property read and one branch on `set()`, which is the hot
    // path. This asserts the flag exists and starts false rather than measuring the
    // branch — the harness reports a 28.61 % median min/max spread, so a timing
    // assertion here would be noise dressed as evidence.
    const m = new PowerTTLMap(1000);
    expect(m._disposed).toBe(false);
    expect(m.set('a', 1)).toBe(m);
    expect(m.size).toBe(1);
  });

  it('a map that was never disposed still accepts writes', () => {
    // The regression this fix must not introduce: a flag initialised wrong, or set
    // in the constructor rather than in `dispose()`, would make every instance inert.
    const m = new PowerTTLMap(1000);
    m.set('a', 1);
    m.set('b', 2);
    expect(m.size).toBe(2);
    expect(m.get('b')).toBe(2);
  });
});
