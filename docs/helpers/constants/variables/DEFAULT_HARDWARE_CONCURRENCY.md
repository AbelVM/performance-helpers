[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_HARDWARE\_CONCURRENCY

# Variable: DEFAULT\_HARDWARE\_CONCURRENCY

> `const` **DEFAULT\_HARDWARE\_CONCURRENCY**: `2` = `2`

Fallback for `navigator.hardwareConcurrency` where the runtime does not
expose it.

Node, Deno and every current browser report it, but a non-browser runtime, a
hardened/cross-origin-isolated context, and most test runners do not. `2` is
the smallest value that still permits a worker pool to do anything in
parallel; anything lower silently serialises the pool.
