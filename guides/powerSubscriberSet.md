# PowerSubscriberSet

Shared subscriber registry used by `PowerEventBus` and `PowerObserver`.

`PowerSubscriberSet` manages listener bookkeeping with optional weak references, once-listeners, and max listener limits. It is useful when you need a reusable listener collection that can prune dead weak refs and keep listener delivery simple.

## Constructor

| option         |      type | default | description                                                                             |
| -------------- | --------: | ------- | --------------------------------------------------------------------------------------- |
| `weak`         | `boolean` | `false` | Use `WeakRef`-backed entries when available to allow listeners to be garbage collected. |
| `maxListeners` |  `number` | `0`     | Maximum number of live listeners (0 means unlimited).                                   |

## API

- `add(fn)` — Add a listener and return an unsubscribe callback.
- `addOnce(fn)` — Add a one-time listener that removes itself after invocation.
- `delete(fn)` — Remove a listener by the original function (or once-wrapper).
- `clear()` — Remove all listeners.
- `values()` — Return a safe array copy of currently live listeners.
- `[Symbol.iterator]()` — Iterate live listeners in insertion order.
- `dispose()` / `[Symbol.dispose]()` — Release the registry and detach any weak-reference cleanup. Supports `using` / `await using`. See [Disposal](#disposal).

## Disposal

`PowerSubscriberSet` implements `dispose()` and `[Symbol.dispose]`, so it works with
`using` / `await using` and with a DI container's teardown, like every other
long-lived helper here.

```javascript
{
  using subs = new PowerSubscriberSet({ weak: true, maxListeners: 10 });
  const unsub = subs.add(listener);
  // ...
} // dispose() runs here
```

**There is no timer to cancel.** The set holds listeners and, when `weak: true`,
`WeakRef` handles. `dispose()` clears the listener list and releases the weak
references, so a torn-down set does not keep callbacks alive.

`clear()` is the reversible cousin: it removes all listeners but keeps the set
writable. Use `clear()` to reset a set you intend to reuse; use `dispose()` when
you are finished with it.

## Example

```js
import { PowerSubscriberSet } from 'performance-helpers/powerSubscriberSet';

const subs = new PowerSubscriberSet({ weak: true, maxListeners: 10 });

const listener = (value) => {
  console.log('event value', value);
};

const unsubscribe = subs.add(listener);
subs.addOnce(() => console.log('called once'));

for (const fn of subs) {
  fn('payload');
}

unsubscribe();
```

## Notes

- When `weak: true` is enabled, stale weak references are cleaned up automatically during `values()` and iteration.
- `addOnce()` works with both strong and weak listeners, and removes the listener after it runs.
- `PowerSubscriberSet` is intended as a low-level building block for event and observer implementations rather than a general-purpose public utility.

### Unsubscribing is `O(1)` unless you asked for weak refs

In the default mode `delete(fn)` answers from the set's own hash table and **never walks it**, so removing a listener costs the same whether the set holds ten or ten thousand. Measured before the change: the old scan visited **exactly N** entries to remove the newest-registered listener of an N-entry set, at about **6 ns per entry scanned** — 99 ns at N=1, 451 at N=64, 1577 at N=256, 6195 at N=1024, 23 859 at N=4096, a 240× spread that is linear throughout.

`weak: true` is the deliberate exception, and it is not an oversight. With `WeakRef` entries, a stored entry is not the listener — it is a handle to it — so identity cannot answer "is this the one", and the walk is also what reclaims collected refs. Reclaiming them is the reason to choose weak mode, so a `delete` that skipped it would trade a memory bound for a constant factor. If you have thousands of subscribers and do not need them garbage-collectable, leave `weak` off.

## Validation

`maxListeners` is validated. `0` means **unlimited** and is a real setting, so it
is kept. What changed in 2.0 is the negative case: `maxListeners: -5` was
clamped to `0` by `Math.max(0, ...)`, and on this class `0` means _no cap at
all_ — so a typo silently removed the limit that exists to bound a listener
leak. A negative or non-finite value now throws.
