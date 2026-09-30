[**performance-helpers**](../../README.md)

---

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / CODECS

# Enumeration: CODECS

Frame payload codecs.

- `json` (`0`) — `JSON.stringify` / `JSON.parse` over UTF-8. Portable across
  every runtime and the only choice that interoperates with older peers. Does
  not handle `undefined`, `BigInt`, cycles, `Map`/`Set`, or binary.
- `raw` (`2`) — the value is already an `ArrayBuffer` or typed array and is
  stored verbatim, with no serialization at all.

## Enumeration Members

### JSON

> **JSON**: `0`

---

### RAW

> **RAW**: `2`
