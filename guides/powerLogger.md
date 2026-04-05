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

| method | params | returns | description |
|---|---|---|---|   
| `setDebugLevel(level)` | `number` | `void` | Set runtime debug level. Handles non-numeric input gracefully. |
| `getDebugLevel()` | — | `number` | Return current level. |
| `isDebugLevel(level=1)` | `number` | `boolean` | True if current level >= `level`. |
| `isDebug()` | — | `boolean` | Shorthand for `isDebugLevel(1)`. | 
| `error(...args)` | `...any \| function` | `void` | Log via `console.error` when level >= 1. Accepts lazy functions. |
| `warn(...args)` | `...any \| function` | `void` | Log via `console.warn` when level >= 2. |
| `info(...args)` | `...any \| function` | `void` | Log via `console.info` when level >= 3. |
| `log(...args)` | `...any \| function` | `void` | Log via `console.log` when level >= 3. |
| `debug(...args)` | `...any \| function` | `void` | Verbose debug output via `console.debug` when level >= 3. Supports JSON mode. |
| `table(...args)` | `...any \| function` | `void` | Tabular display using `console.table` when available; in JSON mode emits structured payload. |
| `incrementCounter(name)` | `string` | `void` | Increment an internal counter (no-op when debug disabled). Useful for tests. |
| `getDebugCounters()` | — | `Record<string,number>` | Snapshot of internal counters. |
| `resetDebugCounters()` | — | `void` | Reset all counters. |

## Example

```javascript
const logger = new PowerLogger(2)
logger.warn('This is a warning')
logger.incrementCounter('cache-miss')
```

### Formatter example

You can customize the JSON payload shape by passing a `formatter` function in `options`. The formatter may return an object (which will be JSON.stringified) or a string which will be emitted as-is. Example:

```javascript
const logger = new PowerLogger(3, {
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
const sLogger = new PowerLogger(3, {
	format: 'json',
	formatter: p => `${p.ts}|${p.level}|${String(p.msg)}`
})
sLogger.log('boot')
```

## Recommendations

- Use `PowerLogger` as a small, opt-in instrumentation helper in development and tests. Keep debug-levels low in production.
- Pass lazy functions to debug methods when computing the string is expensive; they will only be evaluated when the message will actually be emitted.

```javascript
const logger = new PowerLogger(2)
logger.warn(() => `Expensive message: ${compute()}`)
```
