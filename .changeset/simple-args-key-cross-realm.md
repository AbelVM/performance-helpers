---
'performance-helpers': patch
---

### Fixed

`simpleArgsKey` — the default `keyResolver` for `PowerMemoizer`, and a public export —
encoded every cross-realm `Date`, `RegExp`, `Map` and `Set` as `'O:{}'`, the same key
as an empty plain object **and as each other**.

Measured with a real `node:vm` second realm:

```js
simpleArgsKey(foreignDate(1)) === simpleArgsKey(foreignDate(2)); // → true
simpleArgsKey(foreignDate) === simpleArgsKey({}); // → true
```

So two distinct calls shared one cache entry and the second was served the first
call's result. Confirmed end to end through a live memoizer: `memo.run(foreignDate(1000))`
then `memo.run(foreignDate(2000))` returned `at-1000` twice, with **one** underlying
invocation. This is a wrong value returned from a public API, not a missed cache entry.

The cause is the defect class `AGENTS.md` records and tells you to grep for rather than
fix site by site: `instanceof` compares against _this_ realm's prototype, so a value
from a `node:vm` sandbox, an iframe or a worker failed all four branches, fell through
to the plain-object branch, and `Object.keys()` returned `[]`.

**`isError` was already routed through a realm-independent predicate on the line
between them**, which is exactly why the file read as covered — the right idea for one
type, and not for the four beside it. This is the third site of this class found by
grepping rather than by being told where to look, and the second in a file that had
already been fixed for it.

`Date` and `RegExp` now use the internal-slot predicates from `powerBuffer.js`. `Map`
and `Set` use the builtin tag, because neither has an accessor that performs a slot
check and the house precedent for containers (`isBucketIterable` in
`powerHistogram.js`) is likewise a structural test. The tag is spoofable via
`Symbol.toStringTag`, and that is acceptable here in a way it is not for a buffer: a
spoof yields a _stable, distinct_ key rather than a collision, so the failure mode is a
cache miss rather than a wrong value — and a spoof that is not iterable throws rather
than encoding silently.

Same-realm keys are byte-identical to before, asserted on the exact strings rather than
compared against each other, because "unchanged" is the claim.

Mutation-checked 6 of 6 reverts killed by a named test: each of the four `instanceof`
restorations, and dropping the `Map` and `Set` branches entirely.
