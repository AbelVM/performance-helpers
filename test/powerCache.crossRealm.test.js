import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { PowerCache } from '../src/helpers/powerCache.js';
import { isArrayBuffer } from '../src/helpers/powerBuffer.js';

// Cross-realm `hasEqual`. `AGENTS.md` records this defect class and the rule that
// comes with it: *"When you fix one site of a defect class, grep for the class and
// not for the site."* It also records that two of the three original sites were in
// code that had **already** been fixed, because `ArrayBuffer.isView` covered views
// and the author read that as covering the file.
//
// That is exactly what happened here. `powerBuffer.js` exports a realm-independent
// `isArrayBuffer()` and `powerMessageCodec.js` was fixed under AUD-011, but
// `deepEqual` in `cache/core.js` was never grepped. It carried **thirteen**
// `instanceof` sites plus a prototype-identity reject, and every one of them
// compared against *this* realm's prototype.
//
// The fixture is a real `node:vm` second realm, not a hand-rolled stand-in.
// `AGENTS.md` is explicit about why: a `{ byteLength: n }` impostor is *accepted*
// by `new Uint8Array()`, so a stand-in would pass for the wrong reason.

/** A second realm, created once. Every foreign value below comes from here. */
const realm = vm.createContext({});
/** Build a foreign `ArrayBuffer` with the given byte contents. */
const foreignBuffer = (bytes) =>
  vm.runInContext(
    `(() => { const b = new ArrayBuffer(${bytes.length}); new Uint8Array(b).set(${JSON.stringify(bytes)}); return b; })()`,
    realm
  );
const foreign = (expr) => vm.runInContext(expr, realm);

describe('PowerCache.hasEqual across realms', () => {
  it('compares a same-realm buffer against a cross-realm one', () => {
    // The realistic shape, and the one that was broken. The cache holds what this
    // realm produced; the caller passes what a `node:vm` sandbox, an iframe or a
    // worker produced. Measured before the fix: `false`, for byte-identical data.
    //
    // The stored value is deliberately **same-realm** here. An earlier draft of
    // this test stored a foreign buffer and compared it against another foreign
    // one, which is the case that worked even before the fix — so the test passed
    // against the broken code and proved nothing. The mutation harness caught it
    // by killing a different test than the one named.
    const cache = new PowerCache();
    const local = new ArrayBuffer(4);
    new Uint8Array(local).set([4, 0, 0, 0]);
    cache.set('k', local);
    expect(cache.hasEqual('k', foreignBuffer([4, 0, 0, 0]))).toBe(true);
    expect(cache.hasEqual('k', foreignBuffer([9, 9, 9, 9]))).toBe(false);
  });

  it('compares a cross-realm buffer against a same-realm one', () => {
    // The other direction, which is a caller storing a foreign value and comparing
    // it against a locally built one.
    const cache = new PowerCache();
    cache.set('k', foreignBuffer([4, 0, 0, 0]));
    const local = new ArrayBuffer(4);
    new Uint8Array(local).set([4, 0, 0, 0]);
    expect(cache.hasEqual('k', local)).toBe(true);
  });

  it('compares two cross-realm buffers from the same foreign realm', () => {
    // The case that worked before the fix, pinned so the reason the defect
    // survived is on record: both values share one foreign prototype, so the
    // prototype-identity reject never fired and only the `instanceof` branches
    // were wrong.
    const cache = new PowerCache();
    cache.set('k', foreignBuffer([4, 0, 0, 0]));
    expect(cache.hasEqual('k', foreignBuffer([4, 0, 0, 0]))).toBe(true);
    expect(cache.hasEqual('k', foreignBuffer([9, 9, 9, 9]))).toBe(false);
  });

  it('still compares same-realm buffers correctly', () => {
    // The fix must not have bought cross-realm correctness by breaking the
    // same-realm path, which is the one every existing test exercises.
    const cache = new PowerCache();
    const a = new ArrayBuffer(4);
    new Uint8Array(a).set([1, 2, 3, 4]);
    const b = new ArrayBuffer(4);
    new Uint8Array(b).set([1, 2, 3, 4]);
    const c = new ArrayBuffer(4);
    new Uint8Array(c).set([9, 9, 9, 9]);
    cache.set('k', a);
    expect(cache.hasEqual('k', b)).toBe(true);
    expect(cache.hasEqual('k', c)).toBe(false);
  });

  it('compares cross-realm views, which isView already covered', () => {
    // Recorded because it is the reason the defect survived: `ArrayBuffer.isView`
    // is realm-independent, so views worked, and the file read as covered. This
    // asserts the case that *did* work so a future change cannot quietly break it.
    const cache = new PowerCache();
    cache.set('v', foreign('new Uint8Array([1,2,3])'));
    expect(cache.hasEqual('v', foreign('new Uint8Array([1,2,3])'))).toBe(true);
    expect(cache.hasEqual('v', foreign('new Uint8Array([9,9,9])'))).toBe(false);
  });

  it('compares a same-realm view against a cross-realm one', () => {
    const cache = new PowerCache();
    cache.set('v', new Uint8Array([1, 2, 3]));
    expect(cache.hasEqual('v', foreign('new Uint8Array([1,2,3])'))).toBe(true);
    expect(cache.hasEqual('v', foreign('new Uint8Array([9,9,9])'))).toBe(false);
  });

  it('compares cross-realm Date, RegExp, Map and Set', () => {
    // The other `instanceof` sites in the same function, each of which had the
    // same defect. One test per type would be clearer; one table is shorter, and
    // the failure names the row.
    const cases = [
      ['Date', 'new Date(0)', 'new Date(0)', 'new Date(1000)'],
      ['RegExp', '/ab+c/g', '/ab+c/g', '/xy+z/i'],
      ['Map', "new Map([['a',1]])", "new Map([['a',1]])", "new Map([['b',2]])"],
      ['Set', 'new Set([1,2,3])', 'new Set([1,2,3])', 'new Set([4,5,6])'],
    ];
    for (const [label, stored, equal, different] of cases) {
      const cache = new PowerCache();
      cache.set('k', foreign(stored));
      expect(cache.hasEqual('k', foreign(equal)), `${label} equal`).toBe(true);
      expect(cache.hasEqual('k', foreign(different)), `${label} different`).toBe(false);
    }
  });

  it('still rejects different types, which the prototype check exists for', () => {
    // The load-bearing half. Relaxing the prototype reject to be realm-tolerant
    // must not have relaxed it for *different types*: `{}` and `new Date()` both
    // have no own enumerable properties, so without the reject they compare equal
    // and the cache hands back the wrong value.
    const cache = new PowerCache();
    cache.set('x', {});
    expect(cache.hasEqual('x', new Date())).toBe(false);
    cache.set('y', new Date(0));
    expect(cache.hasEqual('y', {})).toBe(false);
    cache.set('z', []);
    expect(cache.hasEqual('z', new Map())).toBe(false);
  });

  it('still rejects two different same-realm classes with the same shape', () => {
    // The subtle one, and the reason the relaxation excludes `[object Object]`.
    // Every plain class instance carries that tag, so a tag-only fallback would
    // accept `new Foo()` against `new Bar()` when both have `{ a: 1 }`. Two
    // same-realm classes must still be rejected by prototype identity.
    class Foo {
      constructor() {
        this.a = 1;
      }
    }
    class Bar {
      constructor() {
        this.a = 1;
      }
    }
    const cache = new PowerCache();
    cache.set('f', new Foo());
    expect(cache.hasEqual('f', new Bar())).toBe(false);
    expect(cache.hasEqual('f', new Foo())).toBe(true);
  });

  it('reports a foreign ArrayBuffer as an ArrayBuffer to the shipped predicate', () => {
    // Pins the primitive the fix is built on, so a regression in `isArrayBuffer`
    // fails here rather than only in `powerBuffer`'s own suite.
    expect(foreignBuffer([1]) instanceof ArrayBuffer).toBe(false);
    expect(isArrayBuffer(foreignBuffer([1]))).toBe(true);
  });
});

// A second defect in the same file, found by grepping the *class* rather than the
// site. `deepEqual`'s `Set` branch groups members by a JSON signature to limit
// comparisons, and the signature helper used `instanceof ArrayBuffer` — false for
// a foreign buffer, so every one stringified to `{}` and collided with every
// other object that has no enumerable properties.
//
// The collision alone is only a performance fault. What made it a correctness
// fault is that the `Set` branch compared a colliding pair **twice** — once in
// the signature-candidate loop, once in the structural fallback — and the cycle
// guard at the top of `deepEqual` (`if (mapForA?.has(b)) return true`) answered
// the retry with `true`. A pair that had just compared `false` was reported
// equal.
//
// Measured before the fix: two cross-realm `ArrayBuffer`s holding **different
// bytes** compared `true` inside a `Set` and `false` when compared directly.
describe('PowerCache.hasEqual: a Set of cross-realm values', () => {
  it('compares two foreign buffers with different bytes as unequal', () => {
    // The regression, in its shortest form. Both buffers stringify to `{}`, so
    // they collide; the pair is compared twice; the cycle guard lies.
    const cache = new PowerCache();
    cache.set('s', new Set([foreignBuffer([1, 2, 3, 4])]));
    expect(cache.hasEqual('s', new Set([foreignBuffer([9, 9, 9, 9])]))).toBe(false);
  });

  it('compares two foreign buffers with the same bytes as equal', () => {
    // The control, so the assertion above is not vacuous. Without it a fix that
    // made every foreign Set compare `false` would pass.
    const cache = new PowerCache();
    cache.set('s', new Set([foreignBuffer([1, 2, 3, 4])]));
    expect(cache.hasEqual('s', new Set([foreignBuffer([1, 2, 3, 4])]))).toBe(true);
  });

  it('does not equate a foreign buffer with a plain object', () => {
    // The other collision partner. `{}` and a foreign `ArrayBuffer` both
    // stringify to `{}`, and the retry turned that into a match.
    const cache = new PowerCache();
    cache.set('s', new Set([foreignBuffer([1, 2, 3, 4])]));
    expect(cache.hasEqual('s', new Set([{}]))).toBe(false);
  });

  it('compares a same-realm buffer against a foreign one inside a Set', () => {
    // The realistic shape, matching the direct-comparison test above: the cache
    // holds what this realm produced, the caller passes what a sandbox produced.
    const cache = new PowerCache();
    const local = new ArrayBuffer(4);
    new Uint8Array(local).set([4, 0, 0, 0]);
    cache.set('s', new Set([local]));
    expect(cache.hasEqual('s', new Set([foreignBuffer([4, 0, 0, 0])]))).toBe(true);
    expect(cache.hasEqual('s', new Set([foreignBuffer([9, 9, 9, 9])]))).toBe(false);
  });

  it('compares two foreign RegExps with different sources as unequal', () => {
    // The same defect through a different type. `instanceof RegExp` is also
    // realm-fragile, and a foreign regexp stringifies to `{}` too.
    const cache = new PowerCache();
    cache.set('s', new Set([{ r: foreign('/abc/') }]));
    expect(cache.hasEqual('s', new Set([{ r: foreign('/xyz/') }]))).toBe(false);
    expect(cache.hasEqual('s', new Set([{ r: foreign('/abc/') }]))).toBe(true);
  });

  it('leaves the same-realm Set path correct, which it already was', () => {
    // Pins that the fix did not trade the cross-realm case for the same-realm
    // one. The same-realm path never collided, so it must be untouched.
    const cache = new PowerCache();
    const a = new ArrayBuffer(4);
    const b = new ArrayBuffer(4);
    new Uint8Array(a).set([1, 2, 3, 4]);
    new Uint8Array(b).set([9, 9, 9, 9]);
    cache.set('s', new Set([a]));
    expect(cache.hasEqual('s', new Set([b]))).toBe(false);
    expect(cache.hasEqual('s', new Set([a]))).toBe(true);
  });

  it('leaves Map unaffected, because its branch never uses the signature path', () => {
    // A characterisation, not an aspiration: `Map` compares by key lookup plus a
    // recursive `deepEqual`, so it never had the double comparison. Recorded so
    // that a future change to the `Map` branch is a deliberate decision.
    const cache = new PowerCache();
    cache.set('m', new Map([['k', foreignBuffer([1, 2, 3, 4])]]));
    expect(cache.hasEqual('m', new Map([['k', foreignBuffer([9, 9, 9, 9])]]))).toBe(false);
    expect(cache.hasEqual('m', new Map([['k', foreignBuffer([1, 2, 3, 4])]]))).toBe(true);
  });

  it('still finds a match when the candidate loop fails and the fallback must run', () => {
    // The path the `tried` tracking could have broken. A member whose signature
    // does not collide must still be found by the structural fallback, and a
    // member that genuinely has no match must still report `false` rather than
    // being skipped as "already tried".
    const cache = new PowerCache();
    const local = new ArrayBuffer(4);
    new Uint8Array(local).set([7, 7, 7, 7]);
    // A Set whose members have *different* signatures, so no candidate is ever
    // offered and every match comes from the fallback.
    cache.set('s', new Set([local, { tag: 'a' }, 'primitive-free']));
    expect(
      cache.hasEqual('s', new Set([foreignBuffer([7, 7, 7, 7]), { tag: 'a' }, 'primitive-free']))
    ).toBe(true);
    expect(
      cache.hasEqual('s', new Set([foreignBuffer([7, 7, 7, 7]), { tag: 'b' }, 'primitive-free']))
    ).toBe(false);
  });
});
