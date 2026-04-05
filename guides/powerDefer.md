# PowerDefer

A minimal deferred-promise primitive. Useful for coordination patterns where a promise and its resolvers need to be separated (e.g., signaling, barriers, test harnesses).

## Constructor

| option | type | default | description |
|---|---:|---:|---|
| `new PowerDefer()` | — | — | Returns an object with the properties `promise`, `resolve(value)`, `reject(err)`, and `settled` (boolean). |

## API
| property | type | description |
|---|---:|---|
| `promise` | `Promise<any>` | The promise that will be settled by `resolve` / `reject`. |
| `resolve(value: any)` | `Function` | Resolve the associated promise. No-op if already settled. |
| `reject(err: any)` | `Function` | Reject the associated promise. No-op if already settled. |
| `settled` | `boolean` | `true` when `resolve` or `reject` has been called. |

## Example

```javascript
import { PowerDefer } from '../src/helpers/powerDefer.js';

const d = new PowerDefer();
setTimeout(() => d.resolve('ready'), 100);
await d.promise; // 'ready'
```
