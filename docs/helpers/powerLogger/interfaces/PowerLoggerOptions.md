[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerLogger](../README.md) / PowerLoggerOptions

# Interface: PowerLoggerOptions

## Properties

### format?

> `optional` **format?**: `"text"` \| `"json"`

Output mode for console logging and structured payloads.

***

### formatter?

> `optional` **formatter?**: (`payload`) => `string` \| `Object` \| `null`

Optional formatter for structured payloads. If it returns a string, the string is emitted directly.

#### Parameters

##### payload

`Object`

#### Returns

`string` \| `Object` \| `null`

***

### name?

> `optional` **name?**: `string`

Optional logger name included in structured payloads.

***

### output?

> `optional` **output?**: (`payload`) => `void`

Optional output transport that receives structured payloads or formatted strings.

#### Parameters

##### payload

`string` \| `Object`

#### Returns

`void`
