[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / CHUNK\_WINDOW\_MULTIPLIER

# Variable: CHUNK\_WINDOW\_MULTIPLIER

> `const` **CHUNK\_WINDOW\_MULTIPLIER**: `8` = `8`

Window multiplier for adaptive chunk-size re-estimation.

After the first pass the target is widened to `poolSize * 8`, giving the pool
a deeper queue to chew through before the next measurement. A _wider_ target
means _smaller_ chunks and more of them, so a measurement is taken sooner -
this is the convergence knob, not a throughput knob.
