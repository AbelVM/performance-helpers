# PowerLogger

Simple runtime debug gate and in-memory counters useful for lightweight instrumentation and tests. `PowerLogger` centralizes verbosity control and provides convenience helpers that accept lazy argument functions.

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `level` | `number` | `0` | Initial debug level (0..3). 0 disables logging. |
| `format` | `'text | json'` | `'text'` | When `'json'`, the logger emits structured payloads (stringified by default) suitable for log pipelines. |
| `name` | `string` | `null` | Optional instance name included in JSON payloads as `name`. |
| `formatter` | `(payload) => any` | `null` | Optional function to transform the structured payload before emission. May return an object (serialized) or a string (emitted directly). |
| `output` | `(payload) => any` | `null` | Optional transport function; when provided the logger will call this instead of writing to `console.*`. Receives the structured payload or the formatter's returned value. |

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

- `table(...args)` — When available calls `console.table` for tabular display; in JSON `format` mode it will instead emit a structured payload that can be consumed by log pipelines.

- `incrementCounter(name)` — Increment a named internal counter (no-op when logging disabled). Useful for lightweight metrics and in tests where assertions on counters are required.

- `getDebugCounters()` — Return a snapshot object `{ [name]: count }` of internal counters.

- `resetDebugCounters()` — Reset all internal counters to zero.

## Example

```javascript
import { PowerLogger } from '../src/helpers/powerLogger.js';

const logger = new PowerLogger(2);
logger.warn('This is a warning');
logger.incrementCounter('cache-miss');
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
			msg: payload.msg
		}
	}
})
logger.info('started')

// string-returning formatter example:
const sLogger = new PowerLoggerJSON(3, {
	format: 'json',
	formatter: p => `${p.ts}|${p.level}|${String(p.msg)}`
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
