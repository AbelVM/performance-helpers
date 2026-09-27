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

## Notes

- In a web worker, `detectEnv()` resolves `'webworker'`, and the `new Function('import(...)')` probe never runs — so a strict CSP without `unsafe-eval` is fine.
- A non-function, non-string `workerSource` throws a `TypeError` naming the expected forms.
- `terminate()` returns a `Promise` (matching `worker_threads`); `PowerPool` calls it without awaiting, so a rejected terminate surfaces through the pool's error channel rather than as an unhandled rejection.
- This module is mostly used indirectly, via `PowerPool` and `PowerChunker`. Reach for it directly when you need one worker across runtimes without pulling in the pool.
