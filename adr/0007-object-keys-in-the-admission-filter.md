# 0007. What an object key means to the admission filter

**Status:** Accepted
**Affects:** `PowerCache`, `SmallLfuSketch`, OBS-011, GAP-014
**Evidence:** `node bench/claims.js sketch`. The object-key block was added to that mode as part of adopting this decision — it previously measured string keys only, so the mode named below as the reversal condition could not see the thing it was the reversal condition for.

## Context

`SmallLfuSketch` buckets a key by `String(key)`.
That is deliberate for primitives — the string form is what makes `1`, `'1'` and
`new String('1')` share a counter, so one hot key's history is not split across
two buckets.

It has a consequence for objects, and it was measured rather than reasoned about:

```
three distinct object keys -> estimates:
  {id:"alpha"}: 3   {id:"beta"}: 3   {id:"gamma"}: 3
  {id:"delta"} (never seen): 3
a string key seen once: 1     a never-seen string: 0
```

**Every object key collapses to the single key `"[object Object]"`.** The last
line of that output is the one that matters: a key that has _never been inserted_
reports the same frequency as one inserted three times. The sketch cannot tell a
new object from a hot one, so it has no admission signal to offer — not a noisy
one, none.

**The cache and the filter disagree about what a key is.** `PowerCache` stores
entries in a `Map`, so object keys are compared by _reference_:

```js
const ka = { id: 'a' };
cache.set(ka, 1);
cache.get(ka); // 1
cache.get({ id: 'a' }); // undefined — a different object is a different key
```

So the cache sees N distinct entries and the filter that is supposed to rank them
sees one. Every object key competes against every other through a single counter,
and admission stops discriminating between them.

**Blast radius, stated so this is not read as a P0.** `admission` defaults to
`'none'` (`powerCache.js:239`), so the sketch is opt-in. The failure needs _both_
`admission: 'tinylfu'` and object keys. It is silent, though, and a user who opts
in is opting in _for_ scan resistance — so the thing they bought is not the thing
they received, which is worse than an error. (The same option already carries a
recorded caveat that it underperforms plain LRU on this library's own harness,
`powerCache.js:1618`.)

## Options

**(a) Reject object keys when `admission: 'tinylfu'` is set.** Honest and cheap.
It is also a breaking change to working code, and it rejects the key shape rather
than fixing the filter — a caller with object keys gets told to restructure their
keys rather than told their filter was blind.

**(b) Give the sketch the same identity the cache has.** A `WeakMap<object, id>`
assigning each object key a stable counter, so the sketch's notion of a key
matches the `Map`'s. This is what makes the filter work again rather than
disabling it. The cost is a `WeakMap` read on the hot path — cheaper than the four
FNV loops OBS-011 removed, but not free, and it partly undoes a measured win, so
it should be measured rather than assumed. It also makes the sketch's memory
retention behaviour depend on GC, which the current fixed-width table does not.

**(c) Document it.** "Object keys are not supported by the admission filter." Zero
code, zero cost, and leaves every current user exactly as wrong as they are now.

**(d) An optional key function for admission.** `admissionKey: (k) => string`, so a
caller with object keys supplies the identity they mean. Flexible, and adds public
API for a case the library could handle — and two ways to be wrong instead of one.

## Decision

**(b), adopted. (a) — rejecting object keys — is not needed and was not taken.**

(b) is the only option that leaves a caller who opted into scan resistance with
scan resistance.

### The measurement, and why it reversed the concern

Option (b)'s recorded cost was "a `WeakMap` read on the hot path — cheaper than
the four FNV loops OBS-011 removed, but not free, and it partly undoes a
measured win, so it should be measured rather than assumed". Measured,
`node bench/claims.js sketch`, median of five runs over 200 000 calls, object
keys, increment plus estimate:

| key                                         | string form (was) | identity path (now) |
| ------------------------------------------- | ----------------: | ------------------: |
| plain object                                |          152.6 ns |         **82.5 ns** |
| object whose `toString()` returns 256 chars |         1353.0 ns |        **101.4 ns** |

**It is not a cost. It is between 1.9× and 13× cheaper**, and the gap grows
with the key's text — which is the shape of the claim: `String(key)`
_allocates and walks a string_, while the identity path hashes an integer the
sketch handed out. A plain object's string form is the constant
`"[object Object]"`, so a caller who never defines `toString` pays the small
figure; a caller who does pays the large one, on **every** `get` and `set`.

Two of my own claims were wrong before the measurement settled them, and both
are worth recording because each would have been shipped as a comment:

- I expected the string path's cost to scale with the key's _size_. It does not:
  `String()` on a plain object ignores own properties, so a fatter object
  measured identically. The size sensitivity only appears on a key that defines
  `toString`, which is why that is the key measured above.
- The absolute numbers on this harness are not stable: two runs of the same
  code put the string-key path between 32 ns and 62 ns. So there is deliberately
  **no percentage verdict** in the mode's output. The within-run ratio between
  two object shapes is far outside that spread and is the claim; the gap between
  the two object paths on one run is not.

### Why the discriminating test is distinctness, not a zero

The obvious assertion — "a never-seen object key must estimate 0" — **fails on
the correct implementation**, and I wrote it that way first. Count-Min may
_overcount_, which is its documented safe direction, so at `width: 64` a fresh
id can legitimately land on a neighbour's counter and read 1 or 2.

What the pre-fix shape could not do is give two object keys _different_ answers
at all. `node bench/claims.js sketch`, 200 distinct objects, one increment each:

| shape            |  sum | distinct estimates | never-seen object |
| ---------------- | ---: | -----------------: | ----------------: |
| object (shipped) |  509 |       **5 of 200** |             **2** |
| object (was)     | 3000 |       **1 of 200** |            **15** |

Before, every object key shared one counter: the same estimate for all 200, and
the key that had never been inserted reported the same again. That is the
defect, and it is not repairable by tuning — no width fixes a key space of one.

### Consequences

- The sketch stops being a fixed-width table plus a string coercion and gains a
  per-object identity. `SmallLfuSketch`'s public surface is unchanged; the
  identity is internal, and `SmallLfuSketch` is not exported from the package.
- A `WeakMap` per sketch, allocated lazily, so a cache that only ever sees
  primitives never allocates one. It is **weak on purpose**: the sketch's memory
  is otherwise a fixed `width * depth / 2` bytes that `size()` reports exactly,
  and a strong map would make that number untrue the moment a caller cached a
  short-lived request object. **This is the one property of the change that no
  test can observe** — retention is not behaviour, and a GC-dependent test would
  be a flake — so it rests on the code and this note rather than on a green
  suite.
- `null`, symbols and bigints keep hashing **by value**. `null` is
  `typeof 'object'` but its string form is `"null"`; a symbol's description is
  not its identity; a BigInt stringifies to its digits. All three are pinned by
  asserting the counter they share with the string that spells them, which is
  what "by value" means and what fails if one of them is routed to the `WeakMap`.
- **No salt on the identity hash**, and the first draft of the code had one with
  a comment justifying it. The justification did not survive checking: an id `3`
  and the string key `'3'` arrive as different hashes already (`3` versus FNV-1a
  of `"3"`), and where two hashes do share a column that is the Count-Min
  collision the sketch exists to absorb. So the salt came out rather than ship
  as a cost with no claim behind it.
- The measured hashing win recorded in `smallLfu.js` (4× FNV to 1×) is
  **unaffected**: primitives take the same string path, and the added cost there
  is one `typeof` check.
- One existing test changed shape, and it is worth naming because "the tests
  passed" would have hidden it. `test/smallLfu.hashOnce.test.js` pinned _hash
  once per call, not once per row_ through an object key with a counting
  `toString`. An object key is no longer stringified at all, so that counter now
  reads **0** rather than `1`. The assertion was tightened rather than removed —
  `0` at every depth, where the per-row mutant reads `depth` — and the primitive
  path, which cannot be observed through a user `toString` at all, is pinned
  separately by counting calls into `_hash`.

## What would change this decision

- `bench/claims.js sketch` showing the identity path costing more than the
  string form. It does not, and the reversal condition is checked in the same run
  that reports the discrimination, so the two cannot be reported out of step.
- Someone needing `String(key)` semantics for an object — that is, a caller who
  _wants_ `{id:'a'}` and `{id:'a'}` to share a frequency history. That is a real
  use, and this decision removes it. It is also what `powerCache.md` documents:
  object keys are reference keys to the cache, and the filter now agrees with
  the cache rather than with a coercion. A caller who needs value semantics has
  a string key one `JSON.stringify` away, which is cheaper than the coercion
  they are giving up.
