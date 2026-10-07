# PowerOperationContext

`createOperationContext` creates a frozen plain object for passing operation coordination data explicitly between helpers.

```js
import { createOperationContext } from 'performance-helpers';

const context = createOperationContext({
  signal,
  deadlineMs: 250,
  retryBudget,
  correlationId: 'request-42',
  priority: 1,
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
