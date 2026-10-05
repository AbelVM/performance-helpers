[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerCrossLock](../README.md) / hasCrossWorkerLocks

# Function: hasCrossWorkerLocks()

> **hasCrossWorkerLocks**(): `boolean`

Whether this platform has a cross-worker lock manager at all.

`LockManager` is in Node (24.x) and in Chromium and Firefox. It is **not** gated on
`crossOriginIsolated` — the row's claim on that point holds, and it is worth stating
because it is why this helper needs no SAB fallback, unlike SAB-003 and SAB-004.

## Returns

`boolean`
