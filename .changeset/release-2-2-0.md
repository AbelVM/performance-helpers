---
'performance-helpers': minor
---

- `PowerOperationContext`: async-local propagation via `runOperationContext` / `getOperationContext` / `withOperationContext` (S-37), using `node:async_hooks` `AsyncLocalStorage` with a browser fallback.
- `PowerPool.drain()`: optional `onProgress` callback + `drain:progress` events reporting `{ activeTasks, queueLength }` (R-09).
