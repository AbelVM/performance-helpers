---
'performance-helpers': patch
---

Fixes `new PowerPool(Worker, null)` throwing an error about an internal field.

The constructor's options guard explicitly exempts `null`
(`arguments[1] != null`), but the option destructuring runs before it, and a
default parameter only covers `undefined`. Passing `null` therefore reached the
destructuring and threw:

```
TypeError: Cannot read properties of null (reading 'size')
```

which names an internal field rather than the argument the caller got wrong,
and the guard written to allow the case never got the chance to run. `null` is
now normalised to `{}` before the destructuring, so the guard means what it
says. Omitting the argument, or passing an object, is unchanged.
