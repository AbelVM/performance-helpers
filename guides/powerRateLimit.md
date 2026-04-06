# PowerRateLimit

Compose multiple rate-limiters and require all to allow consumption before proceeding.

## Constructor

`new PowerRateLimit(limiters: Array, options?)`

`limiters` should be an array of limiter instances implementing `tryConsume(n)` and preferably `available()` and `reset()`.

Options:

| Option | Type | Default | Description |
|---|---:|---:|---|
| `atomic` | `boolean` | `false` | When `true` attempts to provide atomic consumes across composed limiters. See **Atomic semantics** below for details and requirements. |

### Atomic semantics

`PowerRateLimit` supports an `atomic` option that attempts to provide stronger guarantees when consuming tokens across multiple limiters. When `atomic` is enabled (either as a constructor option or per-call via `tryConsume(n, { atomic: true })`) the helper will only succeed when it can ensure either all limiters allow consumption or no limiter is mutated. This requires underlying limiters to expose non-mutating checks (`available()`), or an undo/reservation API (`reserve()` / `release()` / `rollback()` / `addTokens()`). If atomicity cannot be guaranteed the call will return `false` and avoid partial mutations.

## API

- `tryConsume(n?)` — returns `true` only when every underlying limiter permits consuming `n` tokens.
- `reset()` — calls `reset()` on underlying limiters where present.

## Example

```javascript
const limit = new PowerRateLimit([
  new PowerThrottle({ capacity: 100, refillRate: 10 }), // burst limit
  new PowerSlidingWindow({ capacity: 1000, windowMs: 60_000 }), // sustained limit
]);

if (limit.tryConsume()) {
  // proceed: all underlying limiters allowed consumption
}
```
