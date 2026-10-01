[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / MESSAGE\_CODECS

# Variable: MESSAGE\_CODECS

> `const` `readonly` **MESSAGE\_CODECS**: `Set`\<`"framed"` \| `"legacy"` \| `"negotiated"`\>

The `PowerPool` wire modes this module knows how to speak.

A pool validates its `messageCodec` against this set so a typo
(`'framd'`) degrades to the documented default instead of silently
selecting a protocol the caller did not ask for.
