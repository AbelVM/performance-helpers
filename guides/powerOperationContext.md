# createOperationContext

`createOperationContext` creates a frozen plain object for passing operation coordination data explicitly between helpers.

```js
import { createOperationContext } from 'performance-helpers';

const context = createOperationContext({
  signal,
  deadlineMs: 250,
  retryBudget,
  correlationId: 'request-42',
  priority: 1,
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
});
```

Use `deadlineAt` for an absolute timestamp or `deadlineMs` for a relative deadline, but not both. The factory validates the shape and does not start timers or install global state.

## Passing it through a call chain

The context is deliberately plain data. Pass its fields to the helper that
owns each policy; no helper discovers or mutates a process-global context.

```js
const context = createOperationContext({ signal, deadlineMs: 250, retryBudget });

await bulkhead.run(
  () =>
    retry.run(
      (attemptSignal) =>
        pool.postMessage(message, {
          awaitResponse: true,
          signal: attemptSignal,
          deadlineAt: context.deadlineAt,
        }),
      { signal: context.signal, budget: context.retryBudget }
    ),
  { signal: context.signal }
);
```

Keep the total deadline outside retry, pass the same retry budget through every
downstream call, and never convert caller cancellation into a retryable error.
The exact adapter remains application-owned because only the caller knows which
operation is idempotent and which helper owns admission.

## Async-local propagation (S-37)

When threading a context through every call is impractical, bind it to the
current async execution with `runOperationContext` / `getOperationContext`:

```js
import {
  createOperationContext,
  runOperationContext,
  getOperationContext,
  withOperationContext,
} from 'performance-helpers';

const ctx = createOperationContext({ correlationId: 'request-42', deadlineMs: 250 });

await runOperationContext(ctx, async () => {
  // Any code in this async chain can read the context:
  console.log(getOperationContext()?.correlationId); // 'request-42'
  await doWork();
});

// Or create + run in one step:
await withOperationContext({ correlationId: 'request-7' }, async () => {
  await doWork();
});
```

Propagation uses `node:async_hooks` `AsyncLocalStorage` when available (Node).
In runtimes without it (browsers, stripped environments) the helpers degrade
to running the function directly and `getOperationContext()` returns `undefined`,
so callers must still pass the context explicitly there. Nested calls shadow
the outer context.

## Trace context (S-05)

`createOperationContext` accepts optional `traceId` and `spanId` fields for
trace-context propagation. They are carried on the frozen context object and
surfaced through `getOperationContext()`, so downstream helpers and exporters
(e.g. `MetricsCollector.toOTLP()`) can correlate spans without a separate
context channel.
