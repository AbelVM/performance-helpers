# Errors and failure-handling patterns

This guide describes recommended error shapes, common patterns used across the helpers in this repository, and best practices for attaching diagnostic information such as durations, worker ids, and correlation ids.

## Error shapes

- Prefer plain `Error` or subclasses with stable properties: `name`, `message`, `stack`.
- Attach structured diagnostic properties rather than encoding them into the message string. Common fields used in this repo: `duration` (ms), `workerId`, `correlationId`, `status` (HTTP-like numeric code).

Example:

```js
const err = new Error('request failed');
err.duration = 123.4;
err.workerId = 'w-3';
err.correlationId = 'abc-123';
throw err;
```

## Measuring and attaching durations

Helpers such as `measureAsync()` attach a `durationMs` property to thrown errors so callers can log or make decisions based on how long the failing operation ran. When catching errors prefer to check `typeof err.durationMs === 'number'` before trusting the value.

## Correlation ids and pending responses

When using the pool's Promise-based `postMessage(..., { awaitResponse: true })` API, the pool attaches a `correlationId` to the outgoing message and tracks pending responses. The same `correlationId` will normally be present in the worker response. If you implement your own worker handlers, echo `correlationId` back inside the response payload so the pool can resolve the proper Promise.

Worker-side example:

```js
self.onmessage = (e) => {
  const data = e.data;
  // ... process ...
  self.postMessage({ correlationId: data.correlationId, response: result });
};
```

## Best practices for logging

- Log structured JSON when integrating with centralized logging or pipeline tools. `PowerLogger` supports a JSON mode in the library; prefer that in production.
- Avoid swallowing errors silently; if you must, log them at `debug` level with `PowerLogger` so they are available under higher verbosity during troubleshooting.
