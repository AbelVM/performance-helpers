import { describe, it, expect, vi } from 'vitest';
import { simpleArgsKey, PowerMemoizer } from '../src/index.js';

// CACHE-009: `simpleArgsKey` handed the whole argument list to `JSON.stringify`
// the moment it met a non-scalar, and that one decision caused four distinct
// defects. All four measured before any code changed.
//
//   1. `({a:1}, undefined)`, `({a:1}, fn)` and `({a:1}, null)` all produced
//      `'[{"a":1},null]'`, because `JSON.stringify` maps `undefined` and
//      functions to `null`. Confirmed with a live memoizer: two distinct calls,
//      **one** underlying invocation.
//   2. **Every** `Map`, `Set`, `RegExp` and `Error` serialised to `'[{}]'`, so
//      two unrelated `Map`s were indistinguishable. Worse than the reported
//      case — nothing about the inputs suggests they are unencodable.
//   3. A `BigInt` inside an object threw, while a top-level `BigInt` was
//      explicitly supported on the fast path. The same value, two answers.
//   4. A circular structure threw `Converting circular structure to JSON`.

describe('simpleArgsKey: distinct arguments must not share a key', () => {
  it('separates undefined, null and a function', () => {
    // The row's own report, and the one that matters most: two different calls
    // were served each other's cached value.
    const withUndefined = simpleArgsKey({ a: 1 }, undefined);
    const withNull = simpleArgsKey({ a: 1 }, null);
    expect(withUndefined).not.toBe(withNull);
  });

  it('refuses a function rather than aliasing it onto null', () => {
    // The alternative was always going to be a collision: two closures have no
    // comparable identity, and `String(fn)` is identical text for both. Throwing
    // is the only answer that cannot be wrong, and it says what to do instead.
    expect(() => simpleArgsKey({ a: 1 }, () => {})).toThrow(TypeError);
    expect(() => simpleArgsKey({ a: 1 }, () => {})).toThrow(/keyResolver/);
    // A named function is the same case: a name is not an identity.
    expect(() => simpleArgsKey(function named() {})).toThrow(TypeError);
  });

  it('a memoizer runs the function once per distinct call, not once per alias', () => {
    // The assertion that shows the defect in a form a user would hit, rather
    // than as a key string.
    let invocations = 0;
    const memo = new PowerMemoizer((arg, flag) => {
      invocations++;
      return `${JSON.stringify(arg)}/${String(flag)}`;
    });
    const a = memo.run({ a: 1 }, undefined);
    const b = memo.run({ a: 1 }, null);
    expect(invocations).toBe(2);
    expect(a).not.toBe(b);
  });
});

describe('simpleArgsKey: values JSON.stringify cannot see are distinct', () => {
  // All of these produced the literal string `'[{}]'` before. Two unrelated
  // `Map`s being indistinguishable is worse than the undefined/function case,
  // because nothing about a `Map` suggests it is unencodable.

  it('distinguishes Maps by their contents', () => {
    expect(simpleArgsKey(new Map([[1, 2]]))).not.toBe(simpleArgsKey(new Map([['a', 'b']])));
    expect(simpleArgsKey(new Map([[1, 2]]))).toBe(simpleArgsKey(new Map([[1, 2]])));
  });

  it('distinguishes Sets by their contents', () => {
    expect(simpleArgsKey(new Set([1, 2]))).not.toBe(simpleArgsKey(new Set([9, 9])));
    expect(simpleArgsKey(new Set([1, 2]))).toBe(simpleArgsKey(new Set([1, 2])));
  });

  it('distinguishes RegExps and Errors', () => {
    expect(simpleArgsKey(/a/)).not.toBe(simpleArgsKey(/b/));
    expect(simpleArgsKey(/a/g)).not.toBe(simpleArgsKey(/a/)); // flags are significant
    expect(simpleArgsKey(new Error('x'))).not.toBe(simpleArgsKey(new Error('y')));
  });

  it('distinguishes Dates', () => {
    expect(simpleArgsKey(new Date(0))).not.toBe(simpleArgsKey(new Date(1)));
  });

  it('preserves Map insertion order, which is significant', () => {
    expect(simpleArgsKey(new Map([[1, 2]]))).not.toBe(
      simpleArgsKey(
        new Map([
          [2, 1],
          [1, 2],
        ])
      )
    );
  });
});

describe('simpleArgsKey: values JSON.stringify throws on now encode', () => {
  it('encodes a BigInt nested in an object', () => {
    // The inconsistency: a top-level `BigInt` has been supported on the fast
    // path all along, so the same value had two answers depending on where it
    // appeared.
    expect(simpleArgsKey(1n)).toBe('g:1');
    expect(() => simpleArgsKey({ n: 1n })).not.toThrow();
    expect(simpleArgsKey({ n: 1n })).not.toBe(simpleArgsKey({ n: 2n }));
  });

  it('encodes a circular structure instead of throwing', () => {
    const a = { v: 1 };
    a.self = a;
    const b = { v: 1 };
    b.self = b;
    // Structurally equal cycles match, which is what a memoizer needs.
    expect(() => simpleArgsKey(a)).not.toThrow();
    expect(simpleArgsKey(a)).toBe(simpleArgsKey(b));
  });

  it('distinguishes cycles from a nested object of the same shape', () => {
    const circ = { v: 1 };
    circ.self = circ;
    // Otherwise `c:` would let a cyclic object collide with a finite one.
    expect(simpleArgsKey(circ)).not.toBe(simpleArgsKey({ v: 1, self: { v: 1 } }));
  });

  it('treats a value reached twice on sibling paths as shared, not cyclic', () => {
    // `seen` is a path, not a visited-set. If it were a visited-set, every
    // repeated sibling would encode as `c:` and `{a: shared, b: shared}` would
    // collide with `{a: {}, b: {}}`.
    const shared = { x: 1 };
    expect(simpleArgsKey({ a: shared, b: shared })).toBe(
      simpleArgsKey({ a: { x: 1 }, b: { x: 1 } })
    );
  });
});

describe('simpleArgsKey: the scalar fast path is unchanged', () => {
  // PERF-005 measured this resolver's speed on scalar arguments, and the key
  // format for them is what that measurement's callers would have baked into a
  // persisted store. Only calls that previously hit the broken fallback may
  // change.

  it('keeps the exact codes for scalars', () => {
    expect(simpleArgsKey()).toBe('');
    expect(simpleArgsKey(1, 'a', true, null)).toBe('d:1|s:1:a|b:1|n:');
    expect(simpleArgsKey(undefined)).toBe('u:');
    expect(simpleArgsKey(1n)).toBe('g:1');
  });

  it('keeps length-prefixing and -0 normalisation', () => {
    // Both of these are deliberate collision defences from the original.
    expect(simpleArgsKey('12', '3')).not.toBe(simpleArgsKey('1', '23'));
    expect(simpleArgsKey(0)).toBe(simpleArgsKey(-0));
  });

  it('still refuses a symbol', () => {
    expect(() => simpleArgsKey(Symbol('x'))).toThrow(TypeError);
    expect(() => simpleArgsKey(Symbol('x'))).toThrow(/symbol/);
  });
});

describe('simpleArgsKey: memoization still works', () => {
  it('shares structurally equal objects', () => {
    // The point of the resolver: two equal arguments are one cache entry.
    let invocations = 0;
    const memo = new PowerMemoizer((o) => {
      invocations++;
      return o.v;
    });
    expect(memo.run({ v: 1 })).toBe(1);
    expect(memo.run({ v: 1 })).toBe(1);
    expect(invocations).toBe(1);
  });

  it('separates structurally different objects', () => {
    let invocations = 0;
    const memo = new PowerMemoizer((o) => {
      invocations++;
      return o.v;
    });
    memo.run({ v: 1 });
    memo.run({ v: 2 });
    expect(invocations).toBe(2);
  });

  it('a custom keyResolver still overrides the default', () => {
    // The escape hatch for anything the default refuses, and it has to keep
    // working — the throw is only reasonable because this exists.
    const keyResolver = vi.fn((...args) => JSON.stringify(args));
    const memo = new PowerMemoizer((a) => a, { keyResolver });
    memo.run({ a: 1 }, () => {});
    expect(keyResolver).toHaveBeenCalled();
  });
});
