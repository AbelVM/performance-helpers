---
'performance-helpers': patch
---

### Changed

`deepEqual`'s `Set` branch no longer allocates an array it never reads.

`unsigIndices` was declared, pushed to for every member whose `trySignature` returned
`null`, and never read. It was dead on arrival: the structural fallback scans every
unmatched index, so those members are found whether or not anything remembers them, and
the array could not have changed the answer.

Deleted, with the reason recorded in a comment at the site rather than left for the next
reader to re-derive. A variable that looks load-bearing and is not is the same trap as the
`instanceof` defects this release also fixes — and the coverage report showed its `push`
branch was never even taken, so no test could have observed its absence.

No behaviour change. Verified by re-running the `Set` comparison reproductions (a plain
object against a class instance with identical own properties, and two cross-realm buffers
with different bytes, both still correctly unequal, with the positive controls still equal)
and the three cache test files.
