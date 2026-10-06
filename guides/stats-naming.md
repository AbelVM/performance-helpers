# Stats naming: `stats()` vs `getStats()`

## The two spellings

Every helper that reports anything does it through a method called `stats()`.
`PowerPool` is the exception: it has always spelled its reporting method
`getStats()` and never had a `stats()`. To smooth over that inconsistency the
other helpers also expose `getStats()` as an alias that delegates to `stats()`.
Both spellings work everywhere now.

```js
cache.stats(); // canonical
cache.getStats(); // alias — same return value

pool.getStats(); // PowerPool has no stats() at all
```

`stats()` is the canonical name. Use it in new code. Use `getStats()` when
you are following an existing convention or when the call site already reads
`getStats()` for a different helper.

## Why the alias is written out per class

The alias is installed as a real method on each class, not mixed in through
`Object.defineProperty` on the prototype. That choice is deliberate: a dynamic
property definition is invisible to `tsc`, so the generated `types/` omitted it
and a TypeScript caller got a type error on a method that worked at runtime.
Writing it out in the source makes the type visible to the compiler without any
extra build step.

## Why there is no `@returns` tag on the alias

The first version of the alias carried a hand-copied copy of the `stats()`
return shape, on the reasoning that an explicit type was safer. It was not: the
copy went stale the moment a concurrent change added `staleServes` and
`expirations` to `PowerCache.stats()`, and `test/statsNaming.test.js` failed.

TypeScript inference gives a byte-identical published type and cannot drift,
because there is nothing to keep in sync. `test/types.test-d.ts` asserts the
two are mutually assignable, which is the property a consumer relies on.

## Helper coverage

| Helper                  | Canonical | Alias             |
| ----------------------- | --------- | ----------------- |
| `PowerCache`            | `stats()` | `getStats()`      |
| `PowerBulkhead`         | `stats()` | `getStats()`      |
| `PowerEventLoopMonitor` | `stats()` | `getStats()`      |
| `PowerGCRA`             | `stats()` | `getStats()`      |
| `PowerMessagePort`      | `stats()` | `getStats()`      |
| `PowerPool`             | —         | `getStats()` only |
| `PowerRateLimit`        | `stats()` | `getStats()`      |
| `PowerRealtimeHub`      | `stats()` | `getStats()`      |
| `PowerRetryBudget`      | `stats()` | `getStats()`      |
| `PowerRTCChannel`       | `stats()` | `getStats()`      |
| `PowerSlidingWindow`    | `stats()` | `getStats()`      |
| `PowerSocketAdapter`    | `stats()` | `getStats()`      |
| `PowerThrottle`         | `stats()` | `getStats()`      |
| `PowerWebSocketClient`  | `stats()` | `getStats()`      |

`PowerTTLMap` and `PowerLogger` have no `stats()` and therefore no alias.
