# Caching

- [PowerCache: Caching (LRU + TTL + weight) and memoizing](../guides/powerCache.md). An in-memory, memory-efficient LRU cache with TTL, weighted eviction and an optional reusable node pool. Now with an opt-in `policy: 'slru'` for scan resistance.
- [PowerMemoizer: Function-shaped memoization](../guides/powerCache.md). Call a function and reuse results without manual cache management.
- [PowerTimedCache: Simple TTL cache](../guides/powerCache.md). Auto-started cleanup for "keep this for N milliseconds" use cases.
- [PowerTTLMap: Map with per-key TTL](../guides/powerTTLMap.md). Lightweight `Map`-like store where keys expire lazily on access.
