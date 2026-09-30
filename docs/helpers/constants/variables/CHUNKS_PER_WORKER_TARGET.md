[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / CHUNKS\_PER\_WORKER\_TARGET

# Variable: CHUNKS\_PER\_WORKER\_TARGET

> `const` **CHUNKS\_PER\_WORKER\_TARGET**: `4` = `4`

Target number of in-flight chunks per pool worker when splitting an array.

Aim for roughly `poolSize * 4` chunks, which keeps every worker fed without
queueing far more work than can be in flight. Below that a fast worker idles
between messages; much above it and the chunk list itself becomes the thing
being allocated per call.
