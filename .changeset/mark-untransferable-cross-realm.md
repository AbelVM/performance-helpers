---
'performance-helpers': patch
---

### Fixed

`markUntransferable()` reported a **cross-realm `SharedArrayBuffer` as marked**. The
guard was `typeof SharedArrayBuffer === 'function' && buffer instanceof
SharedArrayBuffer`, and `instanceof` compares against _this_ realm's prototype — so a
buffer produced by a `node:vm` sandbox, an iframe or a worker failed the check, fell
through to the platform marker, and the function returned `true`.

Measured before the fix: a same-realm SAB returned `false` (correct), a cross-realm one
returned `true`. That is the one case where this function's answer is **wrong** rather
than merely conservative. Every other failure mode here is silent by design and
conservative — a browser has no marker, a detached buffer is not markable — but this one
tells the caller a buffer is protected when the platform never marked it.

The check now routes through `isSharedArrayBuffer()` from `src/helpers/powerBuffer.js`,
the realm-independent internal-slot check this repository already uses for the same
defect class in `powerMessageCodec` (AUD-011) and `PowerCache.hasEqual`. The same-realm
fast path is still first, so the common case costs one comparison.

Three tests in `test/powerPool.encodeCacheTransferable.test.js`, all driven by a real
`node:vm` realm rather than a hand-rolled stand-in — a `{ byteLength: n }` impostor is
accepted by `new Uint8Array()`, so a stand-in would pass for the wrong reason. They pin
that a foreign SAB is refused, that a foreign **ArrayBuffer** is still marked (the other
half of the fix, and the regression a careless substitution would introduce), and that a
`Symbol.toStringTag` spoof is not mistaken for a SAB.

Mutation-checked 5 of 5 reverts killed by a named test. The fifth is worth recording: a
`Object.prototype.toString.call(buffer) === '[object SharedArrayBuffer]'` spelling
**survived the first run** and was nearly written off as an equivalent mutant. It is not
one. The platform genuinely accepts `markAsUntransferable` for such an object, so `true`
is the truthful reply and the spoofable check would have reported `false` — a lie about
what the platform did. It is now a test rather than a note.

`types/` and `docs/` needed no regeneration: the signature is unchanged, and
`disableSources` means typedoc emits no line references for a comment edit to
invalidate.
