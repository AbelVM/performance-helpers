# PowerTTLMap

A lightweight Map-like with per-key TTL (milliseconds). Keys expire lazily on access and iteration.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:---|---|
| `defaultTTL` | `number` (ms) | `0` | Default TTL applied when `set(key, value)` is called without a `ttl`. `0` disables expiry. |
| `onExpire` | `Function` | `undefined` | Optional callback called when an entry expires: `(key, value) => void`. Callback errors are swallowed. |

## API

- `set(key, value, ttl?)` — Set a value for `key`. Optionally provide `ttl` in milliseconds to override the map's `defaultTTL`. Returns the map instance to allow chaining.

- `get(key)` — Retrieve the value for `key` or `undefined` if it is missing or expired. Access will lazily purge expired entries.

- `has(key)` — Boolean indicating whether the key exists and is not expired.

- `delete(key)` — Remove an entry. Returns `true` if an entry was removed.

- `clear()` — Remove all entries immediately.

- `touch(key, ttl?)` — Refresh the TTL of an existing key; returns `true` when the TTL was updated.

- `size` (getter) — Number of non-expired entries; accessing this getter will purge expired entries lazily.

- Iteration helpers: `entries()`, `keys()`, `values()` — Iterators over non-expired entries/keys/values respectively. `forEach(cb, thisArg?)` iterates non-expired entries calling `cb(value, key, map)`. `[Symbol.iterator]()` is an alias for `entries()`.

## Example

```javascript
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';

// Example — manage expirable object URLs for served images

const urls = new PowerTTLMap(30_000); // default TTL 30s

// Store an object URL for a generated image and revoke it on expiry
function storePreview(id, objectUrl) {
  urls.set(id, objectUrl);
}

urls.set('img-1', URL.createObjectURL(blob));

// register onExpire to revoke underlying resources when entries age out
const m = new PowerTTLMap(30_000);
m.set('img-1', URL.createObjectURL(blob));
m.onExpire = (key, value) => {
  try {
    URL.revokeObjectURL(value);
  } catch (e) {
    /* ignore */
  }
};

if (m.has('img-1')) console.log('preview ready');
```
