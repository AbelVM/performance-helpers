---
'performance-helpers': patch
---

**Removed `PowerCache`'s `_windowStart` field**, which was assigned `null` in two
places and read by neither.

It was a maintained window pointer, left behind by an attempt that got the
boundary wrong and was reverted. The reason it is deleted rather than left
inert is the point: a commented, unused field whose JSDoc presents it as _the
reason_ the current design derives the window from the list is an invitation
to the next person to populate it — which is exactly the change that already
failed here once. A short comment stands in its place recording that, and
pointing at the open row that still wants the underlying cost removed so it
is not read as a licence to bring the field back.

This is the dead-code half of the cache audit's findings. The other three items
that audit recorded were verified against the current tree first and turned out
to be already fixed, so no working code was touched: the `catch` around a stored
async value is reachable and load-bearing at both of its sites, `assertFunction`
has no unreachable branch after it, and `assertLimit` is pinned directly by the
tests as the non-throwing passthrough that `assertLimitRequired` is defined by
difference from. Type debt falls 290 → 289.
