# WorkerAgnostic

One worker abstraction that works the same in Node, the browser and a web worker.

`WorkerAgnostic` resolves the environment, then hands back a worker-like object no matter where you are. It exists so that code which needs a worker — [`PowerPool`](powerPool.md), [`PowerChunker`](powerChunking.md), your own — does not need a runtime branch.

```javascript
import WorkerAgnostic, { detectEnv, preloadNode } from '../src/helpers/WorkerAgnostic.js';

const worker = await WorkerAgnostic.create(() => new MyWorker());
worker.postMessage({ hello: true });
```

## What it accepts

`WorkerAgnostic.create(workerSource, options)` takes either shape:

| form                      | example                                  | notes                                                                      |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| **a factory function**    | `() => new MyWorker()`                   | the recommended form. Fully synchronous, no module-loading concerns.       |
| **a path or code string** | `'./worker.js'` / `'self.onmessage = …'` | loaded with `importScripts()` in a browser and `new Worker(path)` in Node. |

A **class** is accepted directly and constructed with `new`. An **arrow function or bound function** is called as a factory. A function that throws a `TypeError` mentioning "not a constructor" is retried as a factory, so a callable-vs-constructable mix-up degrades instead of failing.

**A factory that returns a `Promise` throws a clear `TypeError`.** `structuredClone`-style async factories cannot be distinguished from a worker instance (`typeof` reports `object` for both), so an accidental `async` factory is rejected rather than being silently coerced into a useless `{}`.

## API

- `WorkerAgnostic.create(workerSource, options)` → `Promise<WorkerAgnostic>`.
- `new WorkerAgnostic(workerSource, options)` — synchronous; use when you already know the environment.
- `detectEnv()` → `'node' | 'browser' | 'webworker'`. Never throws; returns `'node'` when `Worker` is unavailable.
- `preloadNode()` → `Promise<Worker>`. See the ESM caveat below.
- Instance: `postMessage(message, transfer)`, `terminate()`, `addEventListener` / `removeEventListener`, `on` / `off`, plus `env` and `readyState`.

## A string worker path in a browser: `baseUrl`

```js
new WorkerAgnostic('./workers/task.js', { baseUrl: import.meta.url });
```

In a **browser**, a _string_ worker source that is a **path** (rather than inline
code) is resolved with `new URL(source, baseUrl)`. The base is looked for in this
order:

1. **`options.baseUrl`**, if you supplied it.
2. `document.currentScript.src` — the classic-script base.
3. `location.href` — **the page**.

**You need `baseUrl` in a `<script type="module">`, and only there.** Two things
combine:

- `document.currentScript` is `null` in a module script, per the HTML spec, so step 2
  finds nothing.
- The module's own URL cannot be recovered by this code. The obvious attempt —
  `new Function('return import.meta.url')()` — **does not work**: `new Function`
  evaluates in _global_ scope, where `import.meta` is a syntax error, so the
  generated function fails to parse and the branch silently yields nothing.

So the base falls through to `location.href`, which is the **page**, not the
module. A worker path written relative to the module then resolves against the
page and 404s — and because the fetch is asynchronous, the failure arrives as an
`error` event on the worker rather than a throw at construction, so it reads as a
typo in the path rather than as a resolution failure. That is the failure mode
`baseUrl` exists to remove.

Not needed for a classic script (step 2 works) or for an absolute worker source
(step 1 is unnecessary when nothing has to be resolved). Node is unaffected: a
string source is handed to `node:worker_threads` directly, which does its own
resolution.

## The pure-ESM caveat in Node

Node's `node:worker_threads` is a CommonJS builtin, so in a **pure ESM** module you cannot `require()` it synchronously. `WorkerAgnostic` needs a synchronous `require` **only** for a path/string source; it loads one lazily via `new Function('return import("node:module")')`.

**A factory function never needs it.** If you see:

```
WorkerAgnostic: Node worker_threads is not available synchronously in pure ESM.
Call `await preloadNode()` … or pass a factory function instead of a path string.
```

you are passing a **path string**. Either preload once, or — better — pass a factory:

```javascript
// ESM, no preload needed
const worker = await WorkerAgnostic.create(() => new MyWorker());

// or preload once at startup if you must use a path
import { preloadNode } from 'performance-helpers';
await preloadNode();
const worker = await WorkerAgnostic.create('./worker.js');
```

> `preloadNode` is a **named** export. `WorkerAgnostic.preloadNode` is `undefined` — the class has no such static, and the error message names the import form that actually exists.

## Events

`addEventListener(type, handler)` / `removeEventListener`, or the `on` / `off` aliases. Supported types are `message`, `error` and `messageerror`. A throwing handler is isolated and reported through the logger rather than being allowed to break the dispatcher.

## Disposal

`dispose()` / `[Symbol.dispose]` detach everything the wrapper attached and drop its own listener registry, so it takes part in `using` / `await using` like every other resource-owning helper here:

```javascript
{
  using worker = new WorkerAgnostic(() => new MyWorker());
  worker.addEventListener('message', onMessage);
} // native listeners detached, registry cleared
```

**It does not terminate the worker.** This class wraps a worker handed to it by a caller; `PowerPool` owns the lifecycle of its workers and drives termination itself. So `dispose()` releases what _this object_ attached and leaves the worker running — terminating it would be a lifecycle decision the wrapper has no mandate to make. If you created the worker and you own it, terminate it yourself.

That split is also why the handlers are now stored rather than passed inline. They used to be anonymous arrow functions handed straight to `addEventListener`, so **nothing held a reference and `dispose()` could not have been written against them** — there was no handle to remove. All three native models are covered: `addEventListener`/`removeEventListener`, `on`/`off`, and the `onmessage`/`onerror` property assignment, where a pre-existing handler is restored rather than clobbered.

Idempotent, and safe on an instance whose wiring bailed early.

## Notes

- In a web worker, `detectEnv()` resolves `'webworker'`, and the `new Function('import(...)')` probe never runs — so a strict CSP without `unsafe-eval` is fine.
- A non-function, non-string `workerSource` throws a `TypeError` naming the expected forms.
- `terminate()` returns a `Promise` (matching `worker_threads`); `PowerPool` calls it without awaiting, so a rejected terminate surfaces through the pool's error channel rather than as an unhandled rejection.
- This module is mostly used indirectly, via `PowerPool` and `PowerChunker`. Reach for it directly when you need one worker across runtimes without pulling in the pool.
