[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/metrics](../README.md) / METRICS\_VERSION

# Variable: METRICS\_VERSION

> `const` **METRICS\_VERSION**: `number` = `1`

The snapshot format version.

Bumped when the _shape_ changes, not when a helper adds a field: adding a
key is additive and does not break a consumer that reads named series. A
consumer pins this to detect a shape change it was not written for.
