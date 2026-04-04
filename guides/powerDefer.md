# PowerDefer

A minimal deferred-promise primitive. Useful for coordination patterns where a promise and its resolvers need to be separated (e.g., signaling, barriers, test harnesses).

## Constructor

`new PowerDefer()` — returns an object with the properties `promise`, `resolve(value)`, `reject(err)`, and `settled` (boolean).

## Example

```javascript
import { PowerDefer } from '../src/helpers/powerDefer.js';

const d = new PowerDefer();
setTimeout(() => d.resolve('ready'), 100);
await d.promise; // 'ready'
```

## API

- `promise: Promise<any>` — the promise that will be settled by `resolve`/`reject`.
- `resolve(value: any): void` — resolve the promise (no-op if already settled).
- `reject(err: any): void` — reject the promise (no-op if already settled).
- `settled: boolean` — `true` if `resolve` or `reject` has been called.
