---
'performance-helpers': minor
---

- `PowerOperationContext`: async-local propagation via `runOperationContext` / `getOperationContext` / `withOperationContext` (S-37), using `node:async_hooks` `AsyncLocalStorage` with a browser fallback.
- `PowerPool.drain()`: optional `onProgress` callback + `drain:progress` events reporting `{ activeTasks, queueLength }` (R-09).

- Status reconciliation (pass 3): P-10 and S-24 confirmed already implemented.
