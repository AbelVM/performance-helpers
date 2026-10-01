# PowerLogger

Simple runtime debug gate and in-memory counters useful for lightweight instrumentation and tests. `PowerLogger` centralizes verbosity control and provides convenience helpers that accept lazy argument functions.

## Constructor

| option      |               type | default | description                                                                                                                                                                |
| ----------- | -----------------: | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`     |           `number` |     `0` | Initial debug level (0..3). 0 disables logging.                                                                                                                            |
| `format`    |            `'text' | 'json'` | `'text'`                                                                                                                                                                   | When `'json'`, the logger emits structured payloads (stringified by default) suitable for log pipelines. |
| `name`      |           `string` |  `null` | Optional instance name included in JSON payloads as `name`.                                                                                                                |
| `formatter` | `(payload) => any` |  `null` | Optional function to transform the structured payload before emission. May return an object (serialized) or a string (emitted directly).                                   |
| `output`    | `(payload) => any` |  `null` | Optional transport function; when provided the logger will call this instead of writing to `console.*`. Receives the structured payload or the formatter's returned value. |

## Logging levels

- `0` — disabled
- `1` — errors only
- `2` — errors and warnings
- `3` — info and verbose logs

## API

- `setDebugLevel(level)` — Set runtime debug level (number). Accepts non-numeric input gracefully by coercion where useful; controls which log methods emit output.

- `getDebugLevel()` — Return the current numeric debug level.

- `isDebugLevel(level = 1)` — Returns `true` when the current debug level is greater than or equal to `level`.

- `isDebug()` — Convenience shorthand for `isDebugLevel(1)`.

- `error(...args)` / `warn(...args)` / `info(...args)` / `log(...args)` / `debug(...args)` — Logging methods that behave according to the configured level. Each accepts variadic arguments or lazy functions (functions that will be invoked only when the message will actually be emitted) to avoid unnecessary work when logging is disabled.

### How `error()` formats its arguments

`error()` is the only level that rewrites what you pass it, so the rules are worth
stating. Per argument, in order:

1. A normalized error object (anything with a truthy `.error`) is rendered as
   `CODE: message`.
2. An `Error` **or any plain object** is rendered the same way, as
   `ERR_ITEM: message`.
3. Everything else — strings, numbers, `null`, `undefined` — is passed through
   untouched.

Two consequences that surprise people:

- **A plain object is not logged as an object.** `logger.error({ id: 7 })`
  emits the string `ERR_ITEM: `, because `normalizeError` reads only `.code`,
  `.message` and `.stack` and an object has none of them. Use `logger.info()` if
  you want the object itself, or an `output` transport in `json` format.
- **Errors from another realm are formatted correctly.** An `Error` created in a
  different `vm` context, worker or iframe fails `instanceof Error` in this one.
  The check here is realm-independent, so it does not matter — and it did not
  matter before either, because the clause that formats plain objects already
  caught them. `test/powerLogger.isError.test.js` pins that a `vm`-created
  `TypeError` and a local one produce byte-identical payloads.

- `table(...args)` — When available calls `console.table` for tabular display; in JSON `format` mode it will instead emit a structured payload that can be consumed by log pipelines.

- `incrementCounter(name)` — Increment a named internal counter (no-op when logging disabled). Useful for lightweight metrics and in tests where assertions on counters are required.

- `getDebugCounters()` — Return a snapshot object `{ [name]: count }` of internal counters.

- `resetDebugCounters()` — Reset all internal counters to zero.

## Example

```javascript
import { PowerLogger } from '../src/helpers/powerLogger.js';

const logger = new PowerLogger(3, {
  format: 'json',
  name: 'user-service',
  output(payload) {
    // Send structured logs to a centralized pipeline.
    sendToLogPipeline(payload);
  },
});

async function handleRequest(req, res) {
  const traceId = req.headers['x-request-id'] || crypto.randomUUID();
  const start = Date.now();

  logger.info(() => ({
    event: 'request.start',
    traceId,
    method: req.method,
    path: req.url,
  }));

  try {
    const user = await getUserProfile(req.params.id);
    logger.incrementCounter('cacheHit');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(user));
  } catch (error) {
    logger.error(() => ({
      event: 'request.error',
      traceId,
      error: String(error),
    }));
    res.writeHead(500).end('Internal Server Error');
  } finally {
    logger.info(() => ({
      event: 'request.end',
      traceId,
      durationMs: Date.now() - start,
    }));
  }
}
```

### Formatter example

You can customize the JSON payload shape by passing a `formatter` function in `options`. The formatter may return an object (which will be JSON.stringified) or a string which will be emitted as-is. Example:

```javascript
import { PowerLogger as PowerLoggerJSON } from '../src/helpers/powerLogger.js';

const logger = new PowerLoggerJSON(3, {
  format: 'json',
  name: 'my-app',
  formatter(payload) {
    // return a custom object
    return {
      t: payload.ts,
      lvl: payload.level,
      app: payload.name || 'unknown',
      msg: payload.msg,
    };
  },
});
logger.info('started');

// string-returning formatter example:
const sLogger = new PowerLoggerJSON(3, {
  format: 'json',
  formatter: (p) => `${p.ts}|${p.level}|${String(p.msg)}`,
});
sLogger.log('boot');
```

## Recommendations

- Use `PowerLogger` as a small, opt-in instrumentation helper in development and tests. Keep debug-levels low in production.
- Pass lazy functions to debug methods when computing the string is expensive; they will only be evaluated when the message will actually be emitted.

```javascript
import { PowerLogger as PowerLoggerLite } from '../src/helpers/powerLogger.js';

const logger = new PowerLoggerLite(2);
logger.warn(() => `Expensive message: ${compute()}`);
```
