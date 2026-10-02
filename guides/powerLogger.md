# PowerLogger

Simple runtime debug gate and in-memory counters useful for lightweight instrumentation and tests. `PowerLogger` centralizes verbosity control and provides convenience helpers that accept lazy argument functions.

## Constructor

| option      |               type | default | description                                                                                                                                                                                                                                                          |
| ----------- | -----------------: | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level`     |           `number` |     `0` | Initial debug level (0..3). 0 disables logging.                                                                                                                                                                                                                      |
| `format`    |            `'text' | 'json'` | `'text'`                                                                                                                                                                                                                                                             | When `'json'`, the logger emits structured payloads (stringified by default) suitable for log pipelines. |
| `name`      |           `string` |  `null` | Optional instance name included in JSON payloads as `name`.                                                                                                                                                                                                          |
| `formatter` | `(payload) => any` |  `null` | Optional function to transform the structured payload before emission. May return an object (serialized) or a string (emitted directly).                                                                                                                             |
| `output`    | `(payload) => any` |  `null` | Optional transport function; when provided the logger will call this instead of writing to `console.*`. Receives the structured payload or the formatter's returned value. **A sink that throws is reported via `console.error` and otherwise ignored** — see below. |

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
2. An `Error` is rendered the same way, as `ERR_ITEM: message` when it has no
   `code`.
3. **A plain object is passed through as an object**, fields and `stack` intact.
4. Everything else — strings, numbers, `null`, `undefined` — is passed through
   untouched.

**Changed in 2.0: step 3 used to say "or any plain object" and was rendered
identically to step 2.** So `logger.error({ id: 7 })` emitted the string
`ERR_ITEM: ` and the object was gone, and `{ code: 'EPLAIN', message: 'x', stack:
'S' }` emitted `"EPLAIN: x"` — the `stack` read by `normalizeError` and then
discarded by the string formatter. If your code branched on a **string** `msg`
from `error()`, check it: a sink now receives the object.

Two consequences worth stating:

- **A disabled level now costs nothing.** `error()` used to check the level
  _after_ formatting its arguments, so a level-0 build still ran the whole map —
  and a getter on a logged object still fired. The check is now the first
  statement, so `logger.error(obj)` at a disabled level touches nothing. If your
  object's `code` or `stack` getter has a side effect, it will no longer run when
  error logging is off. (`warn`, `info` and `log` never formatted eagerly, so
  they were never affected.)
- **Errors from another realm are formatted correctly, and still are.** An
  `Error` created in a different `vm` context, worker or iframe fails
  `instanceof Error` in this one. The check is realm-independent — it is a
  **brand** check, not a prototype check — so a cross-realm `Error` passes. That
  is what the old `|| typeof a === 'object'` clause used to buy, and why removing
  it is safe: `test/powerLogger.isError.test.js` pins that a `vm`-created
  `TypeError` and a local one produce byte-identical payloads.

- `table(...args)` — When available calls `console.table` for tabular display; in JSON `format` mode it will instead emit a structured payload that can be consumed by log pipelines.

- `incrementCounter(name)` — Increment a named internal counter (no-op when logging disabled). Useful for lightweight metrics and in tests where assertions on counters are required.

- `getDebugCounters()` — Return a snapshot object `{ [name]: count }` of internal counters.

- `resetDebugCounters()` — Reset all internal counters to zero.

### A sink that throws

An `output` transport is caller code on the logging path, so **it is not allowed
to take the logger — and therefore the pool, cache or circuit that owns it — down
with it.** If it throws, the logger swallows the throw and reports it once via
`console.error('PowerLogger: log sink threw', err)`, then gives up if that call
itself throws.

**Both sink paths are reported.** In 2.0 this only held on the path where a
`formatter` returns a string; the structured-`output` path — the one nearly every
caller takes — swallowed silently, so a sink failing on every record was
indistinguishable from a logger with `level: 0`. That is the trap this note
exists to close: if your logs went quiet, check whether your sink is throwing
rather than assuming the level was changed.

`test/powerLogger.sinkAndLevel.test.js` pins both branches, that a throwing
`console.error` does not escalate into a thrown log call, and that a healthy sink
reports nothing at all.

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
