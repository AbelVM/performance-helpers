# PowerTaskGroup

Structured concurrency: a scope that runs async tasks and cancels all of them on
exit.

`PowerTaskGroup` (also called a `Scope`) owns an `AbortController` and a set of
in-flight tasks. Every task receives the scope's `AbortSignal`; when the scope
is disposed (or a task rejects and `cancelOnError` is set) all siblings are
aborted and the scope waits for them to settle.

```js
import { PowerTaskGroup } from 'performance-helpers';

const scope = new PowerTaskGroup({ cancelOnError: true });
try {
  await scope.run(async (signal) => {
    const res = await fetch('/data', { signal });
    return res.json();
  });
} finally {
  await scope.dispose();
}
```

## Constructor

| Option          | Type      | Default | Description                         |
| --------------- | --------- | ------- | ----------------------------------- |
| `cancelOnError` | `boolean` | `true`  | Abort siblings when a task rejects. |

## API

- `signal` — the scope's `AbortSignal`, shared by every task.
- `disposed` — whether the scope has been disposed.
- `size` — number of tasks currently in flight.
- `run(fn)` — run an async task; `fn` receives the signal. Returns a promise.
- `spawn(fn)` — alias for `run` without awaiting.
- `all()` — wait for all in-flight tasks to settle; returns their results.
- `cancel()` — abort every in-flight task and wait for them to settle.
- `dispose()` / `[Symbol.asyncDispose]()` — abort and await all tasks.
- `[Symbol.dispose]()` — abort all tasks synchronously (does not await).

## Notes

- With `cancelOnError: true` (default), the first rejection aborts siblings.
- `using` (sync) aborts but does not await; `await using` awaits settlement.
- Tasks started after dispose reject immediately.
