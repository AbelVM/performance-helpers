---
'performance-helpers': patch
---

fix: a leading numeric argument is now accepted positionally _or_ as an option

Six helpers took a positional number while about twenty took an options object,
and the split had no rule a reader could infer. `PowerTTLMap` already normalised
both forms — the right answer, applied to one class out of seven. The other five
did not, in two distinct ways, both bad:

```js
new PowerLogger({ level: 2 }); // silently came up at level 0
new PowerObserver({ value: 5 }); // stored the *object* as the observed value
new PowerSemaphore({ limit: 3 }); // threw, naming a number you just passed an object for
```

`PowerLogger` is the worse of the two silent cases: a logger asked to be verbose
was quiet, with nothing to indicate why. `PowerObserver` was worse still — it
appeared to work while observing `{ value: 5 }` rather than `5`.

All five now accept both forms. **Positional calls are untouched**, so this is
additive; nothing that compiles today stops compiling.

Two rules keep it honest rather than a second way to be wrong:

- **An object is read as options only when it carries a known option key.** A
  bare `{}` still falls through to the numeric path and is rejected, which
  `test/powerLatch.reset.test.js` already pins as a property — "whatever the
  constructor rejects, `reset()` must reject too". A looser normalisation broke
  that on the first attempt and the existing test caught it.
- **The whole object is validated, not just the key being read.** Otherwise
  `{ limit: 3, nonsense: 1 }` would pass, and arriving in the options-object form
  would be a way to _bypass_ the strict-options check in 8f83c07 rather than a
  second way to satisfy it.

Pinned in `test/constructorForms.test.js`, including that the object form is not
a validation bypass. Mutation-checked: dropping the `assertKnownOptions` call
from the `PowerSemaphore` branch fails the test.
