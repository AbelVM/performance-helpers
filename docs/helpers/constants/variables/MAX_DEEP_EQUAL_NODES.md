[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / MAX\_DEEP\_EQUAL\_NODES

# Variable: MAX\_DEEP\_EQUAL\_NODES

> `const` **MAX\_DEEP\_EQUAL\_NODES**: `10000` = `10_000`

Ceiling on how many _nodes_ one `hasEqual` deep comparison will visit.

`MAX_DEEP_EQUAL_DEPTH` bounds depth and says nothing about width, so a wide
flat value - an array of a million scalars, say - recurses at depth 2, never
trips the depth limit, and blocks the event loop for tens of milliseconds
on what a caller expects to be a cache lookup. This bounds the work instead.

Exceeding it degrades to reference equality, which is the same contract the
depth limit already used: the answer becomes less thorough, never wrong.
10_000 nodes is far beyond any hand-written comparison and well inside a
tick, which is the whole point - a cache lookup should not cost 37 ms.
