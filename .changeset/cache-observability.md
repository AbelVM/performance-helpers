---
'performance-helpers': patch
---

fix(cache): `observability` was read by the constructor and missing from `PowerCacheOptions`

`PowerCache`'s constructor calls `attach(this, 'cache', options)`, and
`attach()` in `src/helpers/metrics.js` reads `options.observability` to decide
whether to register the helper with the shared `MetricsCollector`. The option
worked; `PowerCacheOptions` did not declare it, so a TypeScript caller could not
pass it.

Seven of the eight constructors that call `attach()` declared the field. This was
the one that did not, which is the harder half of the bug to see — nothing fails,
the option is documented in `guides/metrics.md`, and seven sibling classes accept
it, so the gap reads as an oversight in the type rather than a missing feature.

Same defect class as `PowerPool`'s `encodeCacheLimit` / `encodeCacheByteLimit`,
fixed in 3d54d29. Both were found by a pass built to reject options a class does
_not_ accept, which flagged them as the exception.

Pinned in `test/types.test-d.ts` across all eight `attach()` callers, so a future
removal is caught by this repository's compiler rather than a consumer's.

One limit stated rather than left to be found: the _value_ type is not enforced —
`new PowerCache({ observability: 'yes' })` still compiles, so the declared
boolean-or-collector union is not checked at the constructor. Only acceptance is
asserted here. Tightening the value type is separate work.
