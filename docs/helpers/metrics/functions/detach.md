[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / detach

# Function: detach()

> **detach**(`receipt`): `boolean`

Undo an [attach](attach.md). Safe to call with `null`, so a helper can call it
from a teardown path that may never have attached.

## Parameters

### receipt

\{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

## Returns

`boolean`

Whether a source was removed.
