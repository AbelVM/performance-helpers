[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_POOL\_SIZE

# Variable: DEFAULT\_POOL\_SIZE

> `const` **DEFAULT\_POOL\_SIZE**: `2` = `2`

How many workers a `PowerPool` starts with when the caller names no `size`.

Deliberately small even on a 64-core box. A pool is usually constructed at
module load, when the work it will eventually do is unknown, and a pool that
eagerly spawns one worker per core pays that startup cost — and holds that
memory — whether or not the traffic ever arrives. Start at two and let
`autoScale` or the reaper move it. This is both the default initial `size`
(capped by real concurrency) and the default `minSize`, because they express
the same decision: start small. They are one constant for that reason, and
splitting them would imply they can differ.
