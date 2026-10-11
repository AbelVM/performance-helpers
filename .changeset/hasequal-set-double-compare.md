---
'performance-helpers': patch
---

### Fixed

`PowerCache.hasEqual` reported a `Set` as equal when it was not. The `Set` branch of
`deepEqual` groups members by a JSON signature to limit comparisons, then falls back
to a structural scan. When two members produced the **same signature** but compared
unequal, the pair was compared **twice** — once in the signature-candidate loop, once
in the structural fallback — and the cycle guard at the top of `deepEqual`
(`if (mapForA?.has(b)) return true`) answered the retry with `true`. A pair that had
just compared `false` was reported equal.

**This needs no cross-realm fixture to reproduce.** Measured at `HEAD`:

```js
class Foo {
  constructor() {
    this.a = 1;
  }
}
const cache = new PowerCache();
cache.set('s', new Set([{ a: 1 }]));
cache.hasEqual('s', new Set([new Foo()])); // → true. Should be false.
```

A plain object and a class instance with identical own properties produce the same
signature, so they collided. The direct comparison of the same two values was always
correct — only the `Set` path was wrong. `Map` is unaffected: its branch never uses
the signature path.

The cross-realm shape of the same defect also reproduced, and is what led here: two
cross-realm `ArrayBuffer`s holding **different bytes** compared `true` inside a `Set`,
because `trySignature` used `instanceof ArrayBuffer` — false for a foreign buffer, so
every one stringified to `{}` and collided with everything else that does.

The fix tracks which candidates have already been compared for the member being
matched, so the fallback never re-compares a pair. It is a generation stamp rather
than a per-member array: the first draft allocated `new Array(n).fill(false)` inside
the loop, which is O(n) per member and O(n²) overall, and measured **6.2× slower** on
a 400-element `Set` of same-realm buffers — a regression on a path that was already
correct.

Mutation-checked 3 of 3 correctness reverts killed by a named test: reverting the
tracking in the fallback, dropping the mark in the candidate loop, and reverting
`isDate` to a broken form.

### Changed

`trySignature`'s type tests are now realm-independent, and the four type predicates in
`powerBuffer.js` gained a tag pre-filter ahead of the internal-slot check.

`isRegExp` and `isDate` are new. `isArrayBuffer` and `isSharedArrayBuffer` keep their
semantics exactly; only the rejection path changed.

**The tag is a pre-filter, not the test.** `Object.prototype.toString` reads the
internal builtin slot, so it is realm-independent — but it is also spoofable via
`Symbol.toStringTag`, so the accessor still runs and still has the final word. What
the tag buys is the rejection path: measured on Node 24.18, asking the accessor about
a non-matching value costs **44.9 ms per 16k calls** because every one throws a
`TypeError`, while the tag rejects the same values in **0.88 ms** — 51×. A caller
walking arbitrary user values pays that on every value.

`isDate`'s internal-slot check is a **call**, not a property read, and the first draft
got that wrong: `Date.prototype.getTime` is a method, so
`Reflect.get(Date.prototype, 'getTime', value)` returns the function for an
`ArrayBuffer`, a plain object and a string alike without throwing. It returned `true`
for every object. The slot check happens on invocation, so that is how it is spelled.

### Performance

Interleaved A/B against `HEAD`, best of 6 per arm, 400-element `Set` comparisons:

| case                |   `HEAD` |      now |     delta |
| ------------------- | -------: | -------: | --------: |
| same-realm objects  | 2.671 ms | 0.508 ms | **−81 %** |
| same-realm strings  | 0.024 ms | 0.023 ms |      −4 % |
| same-realm buffers  | 1.422 ms | 1.611 ms |     +13 % |
| cross-realm buffers | 0.791 ms | 1.855 ms |     +97 % |

The last row is not a regression, and the reason is worth stating because the number
looks bad. `HEAD`'s signature helper cost **0.748 ms** for 400 local buffers and
**0.090 ms** for 400 foreign ones — an 8× gap that _is_ the defect. The foreign path
was cheap because `instanceof` failed and it never materialised the bytes. Under this
change the cross-realm path costs what the same-realm path always cost, which is the
correct relationship; the old figure was the price of not looking at the data.

The same-realm buffer row is within this machine's noise: `HEAD` itself measured
1.42 ms and 4.25 ms for that case on two runs.

**These performance changes are pinned by measurement, not by a test.** All four
reverts of them survive the suite, because none of them changes behaviour — that is
what makes them performance changes. The correctness fix above is the part that is
test-killed.
