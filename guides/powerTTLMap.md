# PowerTTLMap

A lightweight Map-like with per-key TTL (milliseconds). Keys expire lazily on access and iteration.

## Constructor

`new PowerTTLMap(defaultTTL = 0)`

- `defaultTTL` (ms): default TTL to apply when `set(key, value)` is called without a TTL. `0` disables expiry by default.
-
## Options

| Option | Type | Default | Description |
|---|---:|---:|---|
| `defaultTTL` | `number` (ms) | `0` | Default TTL applied when `set(key, value)` is called without a `ttl`. `0` disables expiry. |

## API

| Method / Property | Params | Returns | Description |
|---|---|---|---|
| `set(key, value, ttl?)` | `ttl?: number` (ms) | `this` | Set a value. `ttl` overrides `defaultTTL` for this key. |
| `get(key)` | — | `any \| undefined` | Return value or `undefined` if missing or expired. |
| `has(key)` | — | `boolean` | `true` if key exists and is not expired. |
| `delete(key)` | — | `boolean` | Remove a key. Returns whether an entry was removed. |
| `clear()` | — | `void` | Remove all keys. |
| `touch(key, ttl?)` | `ttl?: number` (ms) | `boolean` | Refresh TTL for an existing key. Returns `true` when refreshed. |
| `size` | — | `number` | Number of non-expired entries (getter; purges expired entries lazily). |
| `entries()` | — | `Iterator<[key, value]>` | Iterate non-expired entries. |
| `keys()` | — | `Iterator<key>` | Iterate non-expired keys. |
| `values()` | — | `Iterator<value>` | Iterate non-expired values. |
| `forEach(cb, thisArg?)` | `cb(value, key, map)` | `void` | Iterate non-expired entries calling `cb`. |
| `[Symbol.iterator]()` | — | `Iterator<[key, value]>` | Alias for `entries()`. |

## Example

```javascript
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

const m = new PowerTTLMap(5000); // default TTL 5s
m.set('token', 'abc123');
if (m.has('token')) {
  console.log('token present');
}
// token auto-expires on access after TTL elapses
```
