# PowerLatch

Counting barrier primitive. Resolves pending waiters when the internal count reaches zero.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `count` | `number` | `1` | Initial count required before the latch is released. |

## API

- `countDown(n?)` — Decrement the latch by `n` (default `1`). Returns the remaining count as a `number`. Calling `countDown()` when the count reaches zero has no effect beyond ensuring waiters are resolved.

- `wait()` — Returns a `Promise<void>` that resolves when the internal count reaches zero. If the latch is already at zero the returned promise resolves immediately. `wait()` accepts an optional AbortSignal or numeric timeout when used via the overloads shown in examples.

- `reset(count?)` — Reset the latch to a new value (`count`); if the new count is `0` any pending waiters are resolved synchronously. Use this to reuse a latch instance for repeated coordination rounds.

- `remaining` (getter) — Returns the current remaining count as a `number`.

- `done` (getter) — Boolean flag that is `true` when the remaining count is zero.
 
- `decrementUnlessZero()` — Decrement the latch by `1` only if the current count is greater than zero. Returns the remaining count. Useful when callers must avoid negative counts.

- `abort(reason?)` — Immediately reject all pending `wait()` promises. An optional `reason` (any value) will be used as the rejection reason; when omitted a standard `Error` with `code === 'EABORT'` is used. Calling `abort()` sets the latch into an aborted state and subsequent `wait()` calls reject.

- `onAbort` (getter/setter) — Optional callback property that, when set to a function, is invoked with the abort `reason` whenever `abort()` is called. Errors thrown by the callback are swallowed.

- `one()` (static) — Convenience factory: `PowerLatch.one()` returns a new `PowerLatch(1)`.

## Example

```javascript
import { PowerLatch } from '../src/helpers/powerLatch.js';

// Real-world example: wait for three independent async fetches to complete
const urls = [
  'https://api.example.com/user/1',
  'https://api.example.com/user/2',
  'https://api.example.com/user/3',
];

const latch = new PowerLatch(urls.length);
const results = new Array(urls.length);

urls.forEach((url, i) => {
  (async () => {
    try {
      const res = await fetch(url);
      results[i] = res.ok ? await res.json() : null;
    } catch (err) {
      results[i] = null;
    } finally {
      // signal completion from each independent path
      latch.countDown();
    }
  })();
});

// await all fetches to finish (or fail)
await latch.wait();
console.log('all done', results);
```

## Abort & timeout examples

You can attach an `onAbort` callback when creating the latch or set it later. `wait()` accepts a `{ signal }` AbortSignal or a numeric timeout in milliseconds.

```javascript
// onAbort callback example
const latch = new PowerLatch(2, { onAbort: (reason) => console.warn('latch aborted', reason) });
// elsewhere
const p = latch.wait();
// abort and notify
latch.abort(new Error('shutdown'));
await p.catch((err) => console.log('wait rejected', err.code || err.message));

// wait with AbortSignal
const controller = new AbortController();
const latch2 = new PowerLatch(1);
setTimeout(() => controller.abort(new Error('client aborted')), 50);
await latch2.wait({ signal: controller.signal }).catch((err) => console.log('aborted via signal', err.code));

// wait with timeout
const latch3 = new PowerLatch(1);
await latch3.wait(100).catch((err) => console.log('timed out', err.code));
```

## Note

- **Idempotent abort:** calling `abort()` multiple times has no additional effect beyond the first call — the latch remains aborted and pending waiters are rejected once.
- **Callback safety:** errors thrown by your `onAbort` callback are swallowed by the implementation to avoid breaking caller code.
- **Abort reason:** when `abort()` rejects waiters without a custom reason, the rejection reason will carry `code === 'EABORT'`.

