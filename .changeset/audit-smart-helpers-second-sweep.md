---
'performance-helpers': minor
---

Audit `smart.md` and document the enforcement gaps, hidden coupling, race conditions, default-value traps, test coverage holes, and API inconsistencies found in the second deeper sweep. Completed implementation tasks from that audit:

- **CQ-002**: deduplicate `getStats()` boilerplate — created `guides/stats-naming.md`, replaced 13 verbose JSDoc blocks across 13 helper files with a 5-line cross-reference.
- **CQ-004**: document error-code table — created `guides/errors.md` with `## Codes outside the pool` table (10 codes), satisfying `test/errorCodes.test.js`.
- **DUP-003**: removed local `num()` helper from `normalizeAdaptive()` in `src/helpers/powerBackpressure.js`; replaced with `assertLimitRequired`.
- **FEAT-004**: refuted — premise inverted. `PowerBatch` does not flush-on-size; it flushes on every microtask. `maxWaitMs` would add latency, not reduce it.
- **RT-014**: added `nonRetryableCloseCodes` to `PowerWebSocketClient` with `reconnectExhaustedBy: 'close-code'` stats tracking.
- **RT-003**: added per-topic rate limiting to `PowerRealtimeHub` via `rateLimit` option; drops messages for over-budget topics and increments `stats().rateLimited`.
- **RT-006**: added `connectionUptime` and `backpressureRatio` to `PowerWebSocketClient.stats()`.
- **DX-004**: added generic type parameter `T` to `PowerEventBus` with default `Record<string, any>`. Public methods now accept `keyof T & string` for event names, so a typo is caught at compile time. Updated `guides/powerEventBus.md` and added type tests in `test/types.test-d.ts`.
- **FEAT-005**: added `computed()` and `effect()` reactive primitives to `PowerObserver`. `computed()` derives a signal from other signals; `effect()` runs a callback on change and supports cleanup functions.
- **FEAT-006**: added wildcard/glob subscription support to `PowerEventBus`. Callers can subscribe to `'user:*'` and receive all `user.created`, `user.updated`, etc. events. Matches literal events first, then wildcards; unsubscription removes both literal and wildcard listeners.
- **FEAT-002**: added task priority support to `PowerPool`. `PostMessageOptions` and `PreparedItem` gained an optional `priority` field (default `0`). `PowerQueue` gained `shiftHighestPriority(priorityFn)`; `PowerPool` stores priority on queued items and dispatches highest-priority first, preserving FIFO among equal-priority tasks. Composes with all `queuePolicy` values. 11 tests added in `test/powerPool.priority.test.js`.

No breaking behaviour changes in this commit; the changeset records the findings and the implementation tasks (T-015–T-042) that follow from them.
