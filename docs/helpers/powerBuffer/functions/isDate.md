[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / isDate

# Function: isDate()

> **isDate**(`value`): `boolean`

Whether `value` is a `Date`, from any realm.

**The internal-slot check here is a call, not a property read, and getting
that wrong is silent.** `Date.prototype` has no accessor that performs the
slot check — `getTime` is a *method*, so `Reflect.get(Date.prototype,
'getTime', value)` returns the function for an `ArrayBuffer`, a plain object
and a string alike, without throwing. A first draft of this function was
written that way and returned `true` for every object it was handed; the
tests that caught it were the performance ones, because the caller
(`trySignature` in `cache/core.js`) then called `getTime()` on a buffer, threw,
and lost the signature for every value.

The slot check happens when the method is *invoked*, so that is how it is
spelled: `Date.prototype.getTime.call(value)` throws `TypeError` for a
non-`Date` and returns for a real one, cross-realm included.

## Parameters

### value

`unknown`

## Returns

`boolean`
