# PowerSemaphore

Lightweight async concurrency gate for IO-heavy fanout. Use a semaphore when you need to limit the number of concurrent async operations without blocking the event loop.

## Constructor

| Option | Type | Default | Description |
|---|---:|---:|---|
| `limit` | `number` | `1` | Maximum number of concurrent holders.

## API

- `acquire()` — Returns a `Promise<Function>` that resolves when a permit is available. The resolved function releases the permit.
- `tryAcquire()` — Attempts to take a permit immediately. Returns the release callback when successful, or `null` when no permit is available.
- `run(fn)` — Runs an async callback while holding a permit. The permit is automatically released when the callback settles.
- `limit` — The configured maximum concurrent permits.
- `active` — Number of currently held permits.
- `available` — Number of permits still available.
- `pending` — Number of callers waiting for a permit.
- `isLocked` — `true` when the semaphore is fully acquired.

## Example

```javascript
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';

const semaphore = new PowerSemaphore(3);

const pending = Array.from({ length: 6 }, (_, i) => async () => {
  await semaphore.run(async () => {
    console.log(`task ${i} started`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    console.log(`task ${i} finished`);
  });
});

await Promise.all(pending.map((fn) => fn()));
```

## Real-world use

Use `PowerSemaphore` when you are making many parallel I/O requests and need to avoid overwhelming a service or saturating local resources.

```javascript
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';

const gate = new PowerSemaphore(5);

async function fetchUser(id) {
  const release = await gate.acquire();
  try {
    return await fetch(`https://api.example.com/users/${id}`).then((res) => res.json());
  } finally {
    release();
  }
}

const users = await Promise.all([1, 2, 3, 4, 5, 6].map(fetchUser));
console.log(users.length); // 6
```

## Notes

- `run(fn)` is the easiest way to use `PowerSemaphore` safely because it always releases the permit, even if the callback throws.
- `tryAcquire()` is useful when you want a non-blocking fast path for hot callers.
