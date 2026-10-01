---
'performance-helpers': patch
---

fix(pool): `encodeCacheLimit` and `encodeCacheByteLimit` were read but never declared

Both were read by the `PowerPool` constructor and absent from `PowerPoolOptions`,
so a TypeScript caller could not pass either — the options existed at runtime and
in the implementation, and nowhere a consumer could see them.

    this._encodeCacheLimit = Math.max(
      16,
      options?.encodeCacheLimit ? options.encodeCacheLimit : 64
    );

Found by a pass that was checking for the opposite problem: it rejected options a
class does _not_ accept, and these two came back as the exception — read by the
constructor, missing from the published type. That is worth recording separately,
because a check built to find one class of defect turned up the other, and the
fix is a typedef rather than any change to behaviour.

`encodeCacheLimit` bounds the entry count of the LRU that caches serialized
messages so an identical message is not re-encoded every time (floor of 16,
default 64). `encodeCacheByteLimit` bounds the total bytes it holds, evicting
oldest entries to fit; it defaults to `Infinity`, which leaves the count-only
behaviour unchanged.
