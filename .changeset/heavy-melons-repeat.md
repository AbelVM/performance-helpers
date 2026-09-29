---
'performance-helpers': minor
---

Rejects an `awaitResponse` promise when the worker that owes it is retired.

If a worker was terminated while it still had in-flight `awaitResponse`
requests, the pool decremented the task counter and terminated the worker but
left the caller's promise outstanding. The response was never coming, so the
promise sat until `awaitResponseTimeout` — 30 seconds by default, and **forever**
under `awaitResponseTimeout: Infinity`. Every other path that abandons a pending
response (queue eviction, post failure, pool-growth failure, shutdown) already
rejected it.

It now rejects immediately with a new code:

```js
try {
  const result = await pool.postMessage(payload, undefined, { awaitResponse: true });
} catch (err) {
  if (err.code === 'ERR_POOL_WORKER_TERMINATED') {
    // The work was accepted and is now lost with its worker.
  }
}
```

This is reachable without the caller doing anything, because a worker can be
retired by `resize()`, idle reaping (`idleTimeout`), autoscale shrinking the
fleet, or `stopThePress()`.

Also in this release:

- `PowerPoolShutdownError` now carries `code === 'ERR_POOL_TERMINATED'`, matching
  the synchronous throw from a dispatch method on a shut-down pool. It previously
  had no `code`, so a caller following the `switch (err.code)` pattern in
  `guides/errors.md` fell through to `default` for the case most likely to be
  hit — shutting down while promises are outstanding. `err.name` is unchanged.
- `new PowerPool(Worker, null)` no longer throws
  `TypeError: Cannot read properties of null (reading 'size')`. The options
  guard already exempted `null`, but the option destructuring ran before it.
