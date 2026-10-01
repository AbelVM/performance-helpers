[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / isNativeEnvelope

# Function: isNativeEnvelope()

> **isNativeEnvelope**(`value`): `boolean`

Whether a value is a native structured-clone envelope.

Checked by shape, and that is not sniffing in the sense ADR 0001 rejected:
a discriminator is exactly what a sniffing-free protocol is made of. The
alternative — inferring the carrier from the value — is what the 1.x path
did with `JSON.parse`, and it is what makes a `Date` a string and a `Map` an
object literal.

## Parameters

### value

`any`

## Returns

`boolean`
