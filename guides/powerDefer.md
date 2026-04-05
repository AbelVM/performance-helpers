# PowerDefer

A minimal deferred-promise primitive. Useful for coordination patterns where a promise and its resolvers need to be separated (e.g., signaling, barriers, test harnesses).

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `new PowerDefer()` | — | — | Returns an object with the properties `promise`, `resolve(value)`, `reject(err)`, and `settled` (boolean). |

## API

- `promise` — The `Promise<any>` instance that will be settled by calling `resolve` or `reject`.

- `resolve(value)` — Resolve the associated promise with `value`. No-op if already settled.

- `reject(err)` — Reject the associated promise with `err`. No-op if already settled.

- `settled` (boolean) — `true` when either `resolve` or `reject` has been invoked.

- `status` — One of `'pending' | 'fulfilled' | 'rejected'` reflecting the current lifecycle state. Initially `'pending'`.

- `fulfilled` / `rejected` — Convenience booleans indicating whether the defer has been fulfilled or rejected, respectively.

## Example

```javascript
import { PowerDefer } from '../src/helpers/powerDefer.js';

// Example — wait for a worker/bootstrap handshake
import { PowerDefer } from '../src/helpers/powerDefer.js';
```
const ready = new PowerDefer();

// main thread: wait for worker to signal readiness
worker.onmessage = (e) => {
	if (e.data && e.data.type === 'ready') ready.resolve(e.data.info);
};

// worker posts `{ type: 'ready', info: { version: '1.2.3' } }` when initialized
const info = await ready.promise;
console.log('worker ready', info.version);
```

## Inspecting status

You can inspect whether a `PowerDefer` has been fulfilled or rejected using the new `status`, `fulfilled`, and `rejected` accessors:

```javascript
const d = new PowerDefer();
console.log(d.status); // 'pending'
console.log(d.settled); // false

d.resolve(1);
console.log(d.status); // 'fulfilled'
console.log(d.fulfilled); // true
console.log(d.rejected); // false
```
