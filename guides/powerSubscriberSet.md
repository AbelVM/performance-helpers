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

## Example

```js
import { PowerSubscriberSet } from '../src/helpers/powerSubscriberSet.js';

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

## Validation

`maxListeners` is validated. `0` means **unlimited** and is a real setting, so it
is kept. What changed in 2.0 is the negative case: `maxListeners: -5` was
clamped to `0` by `Math.max(0, ...)`, and on this class `0` means _no cap at
all_ — so a typo silently removed the limit that exists to bound a listener
leak. A negative or non-finite value now throws.
