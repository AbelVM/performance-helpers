[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerBuffer](../README.md) / isRegExp

# Function: isRegExp()

> **isRegExp**(`value`): `boolean`

Whether `value` is a `RegExp`, from any realm.

Same shape and same reason as `isArrayBuffer`: `instanceof RegExp` compares
against *this* realm's prototype, so a regexp from a `node:vm` sandbox, an
iframe or a worker fails it. The internal-slot check is
`Reflect.get(RegExp.prototype, 'source', value)` — the spec's own accessor,
which performs the slot check, returns the source for a real regexp
cross-realm included, and **throws `TypeError`** for an impostor.

`flags` is deliberately not the accessor used: it returns `''` rather than
throwing for a non-regexp, so it cannot detect anything. `source` throws.

`Symbol.toStringTag` is not an option for the usual reason recorded in
`isArrayBuffer`: a `{ [Symbol.toStringTag]: 'RegExp' }` stand-in reports
`[object RegExp]` and would be accepted. The tag is a pre-filter here and the
accessor still has the final word.

## Parameters

### value

`unknown`

## Returns

`boolean`
