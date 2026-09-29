---
'performance-helpers': patch
---

Corrects a documented `postMessage` call that does not work.

`guides/errors.md` showed the pool's Promise API as
`postMessage(msg, { awaitResponse: true })`. `options` is the **third**
parameter, after `transfer`, so the object landed in the transfer slot. With a
plain-object message the pool never inspects the transfer list, so
`awaitResponse` was silently dropped and the call returned `true` instead of a
Promise — a caller awaiting a worker response got a boolean and no diagnostic.
With a typed array the same mistake threw `TypeError: tr is not iterable`.

The guide now shows the three-argument form and explains why the shorthand
fails. No behaviour changes.
