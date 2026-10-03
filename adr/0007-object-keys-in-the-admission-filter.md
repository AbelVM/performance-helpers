# 0007. What an object key means to the admission filter

**Status:** Proposed
**Affects:** `PowerCache`, `SmallLfuSketch`, OBS-011

## Context

`SmallLfuSketch` buckets a key by `String(key)` (`src/utils/smallLfu.js:92-93`).
That is deliberate for primitives — the string form is what makes `1`, `'1'` and
`new String('1')` share a counter, so one hot key's history is not split across
two buckets (`:58-61`).

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

**Proposed: (b), with (a) as a fallback if (b) measures badly.**

(b) is the only option that leaves a caller who opted into scan resistance with
scan resistance. Its cost is a hot-path `WeakMap` read and a retention question,
and both are answerable by measurement — which is the standard this project has
applied to every other performance claim here.

(a) is the fallback because it is strictly better than the status quo even if (b) is
rejected: a loud error beats a filter that quietly does nothing.

(c) is not acceptable on its own and (d) is not preferred over (b), for the reasons
in the options.

## Consequences if (b) is adopted

- The sketch stops being a fixed-width table plus a string coercion, and gains a
  per-object identity. `SmallLfuSketch`'s public surface stays the same; the
  identity is internal.
- A test must pin the thing that is actually broken today: **a never-seen object
  key must not report the frequency of a hot one.** Every option except (b) fails
  that assertion, which makes it the discriminating test for this ADR.
- The measured hashing win recorded in `smallLfu.js:69-86` (4x FNV to 1x) must be
  re-measified if a `WeakMap` read lands on the same path, and `bench/claims.js
sketch` is the mode that reports it.

## What would change this decision

- `bench/claims.js sketch` shows the `WeakMap` read costing more than the
  discrimination is worth on the workloads this library is actually tuned for.
- Object keys turn out to be rare enough in practice that (a) costs more users
  than it protects. That is a question for usage data this project does not have,
  which is itself a reason to prefer the option that does not need the data.
