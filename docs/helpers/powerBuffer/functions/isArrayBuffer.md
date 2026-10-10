[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / isArrayBuffer

# Function: isArrayBuffer()

> **isArrayBuffer**(`value`): `value is ArrayBuffer`

Whether `value` is an `ArrayBuffer`, **across realms**.

`instanceof` compares against *this realm's* `ArrayBuffer.prototype`, so it is
`false` for a buffer created in another `vm` context, another realm, or an
iframe — even though the value is exactly what the caller means. The same is
true of `Symbol.toStringTag`, which is worse than useless here: a plain object
carrying `{ [Symbol.toStringTag]: 'ArrayBuffer' }` reports `[object
ArrayBuffer]` *and* is accepted by `new Uint8Array()`, so that check turns a
spoof into silent corruption rather than a rejection.

`Reflect.get` on the spec's own `byteLength` accessor performs the
**internal-slot check**, which is what actually identifies an `ArrayBuffer` and
is unforgeable: the accessor throws `TypeError` for anything else, cross-realm
or spoofed. Measured: it returns the length for a real buffer and throws for a
tagged impostor.

`instanceof` is kept as the **first** test so the same-realm case — which is
every call on a normal encode or decode — still costs one comparison. Only a
value that fails it pays for `Reflect.get` and the `try`.

**Two guards sit between the fast path and the `try`, and both are
load-bearing.** Measured on the real `collectTransferables`, which calls this
on *every value in a payload*:

- Without the `typeof` guard, `Reflect.get` **throws** for every primitive —
  the `byteLength` accessor performs an internal-slot check and a primitive has
  none. A throw is an exception unwind, not a cheap `return false`: **2 116 %
  slower** (127 ms to 2 812 ms per 200 k calls) than the bare `instanceof` it
  replaced. That regression was introduced by the very change that added the
  cross-realm correctness, and was caught only by measuring.
A primitive cannot be an `ArrayBuffer`, so the `typeof` guard is not a shortcut
that skips work; it is the same answer reached without an exception. The
cross-realm path is untouched: a foreign buffer is still an `object`, so it
still reaches `Reflect.get` and is still identified.

Declared as a type predicate for the same reason `isError` is: `instanceof`
used to *narrow* at every call site, so returning a plain `boolean` here would
have traded a realm bug for two fresh type errors where a bare `ArrayBuffer` is
passed on.

## Parameters

### value

`unknown`

## Returns

`value is ArrayBuffer`
