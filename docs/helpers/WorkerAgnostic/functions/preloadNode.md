[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/WorkerAgnostic](../README.md) / preloadNode

# Function: preloadNode()

> **preloadNode**(): `Promise`\<`void`\>

Preload Node's `worker_threads` `require` for pure-ESM Node environments.

Call this once (and `await` it) before constructing a *string-source* worker
in pure ESM Node, or simply set `globalThis.Worker`. It is NOT needed in
CJS-transpiled contexts (vitest), when passing a factory function, or when
`globalThis.Worker` is already present. Browser builds never need it.

## Returns

`Promise`\<`void`\>
