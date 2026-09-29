---
'performance-helpers': minor
---

Fixes an unreachable guard that let an async worker factory through.

`WorkerAgnostic`'s check for an `async` worker factory sat inside a
`typeof result === 'string'` branch — a branch a Promise can never satisfy,
since `typeof` reports a thenable as `'object'`. The guard never ran.

The visible symptom was a failure several frames from the mistake: an async
factory produced a Promise in place of a worker, and the error the caller saw
was `postMessage is not a function`, pointing at the wrapper rather than at the
factory that caused it.

```js
// Before: silently produced a Promise as its "worker".
new WorkerAgnostic(async () => new Worker('./w.js'));

// After:
new WorkerAgnostic(async () => new Worker('./w.js'));
// TypeError: WorkerAgnostic: an async worker factory was passed. Construct the
// worker synchronously, or await the factory yourself and pass the instance.
```

The check is now a thenable test at the top of the coercion, so it also covers
a hand-rolled thenable rather than only a real Promise.

Also adds `test/WorkerAgnostic.pureEsm.test.js`, which verifies the pure-ESM
`preloadNode()` contract for the first time. Those code paths run only when
`require` is genuinely absent, which vitest never produces — so the behaviour is
tested by importing the real module in a real `node --input-type=module`
subprocess and asserting the documented error, post-preload success, and
idempotency. The troubleshooting guide described that failure on the strength
of reasoning alone; it is now evidence.
