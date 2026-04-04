# performance-helpers

[![npm version](https://img.shields.io/npm/v/performance-helpers.svg)](https://www.npmjs.com/package/performance-helpers) [![npm downloads](https://img.shields.io/npm/dm/performance-helpers.svg)](https://www.npmjs.com/package/performance-helpers) [![GitHub stars](https://img.shields.io/github/stars/AbelVM/performance-helpers.svg)](https://github.com/AbelVM/performance-helpers/stargazers) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)

![logo](assets/logo.png)

Highly tuned lightweight toolbox for high-performance Node/browser code: zero-copy buffer helpers for worker messaging, an LRU TTL cache with a memoizer, a small worker pool wrapper, a tiny runtime debug logger, and much more:

- [PowerCache: Caching (LRU + TTL + weight) and memoizing](guides/powerCache.md). An in-memory, memory-efficient LRU cache with TTL, weighted eviction and an optional reusable node pool.
- [PowerLogging: Gated logging](guides/powerLogger.md). Simple runtime debug gate and in-memory counters useful for lightweight instrumentation and tests.
- [PowerPool: Worker pool](guides/powerPool.md). A small, dependency-free worker pool that wraps underlying Worker instances.
- [PowerBuffer: Encode/decode JS objects to transferables for worker messaging](guides/powerBuffer.md). Lightweight helpers for encoding/decoding JSON to/from binary (Uint8Array / ArrayBuffer / Node Buffer).
- [PowerThrottle: A token-bucket limiter](guides/powerThrottle.md). A tiny rate limiter useful for pacing external work or cooperating with `PowerPool`.
- [PowerSlidingWindow: Sliding-window limiter](guides/powerSlidingWindow.md). A simple rolling-window limiter for quota-style rate limiting.
- [PowerQueue: O(1) ring-buffer queue](guides/powerQueue.md). A resizable, high-performance queue intended for use in `PowerPool` and other high-throughput scenarios.
- [PowerDefer: Deferred promise primitive](guides/powerDefer.md). Small utility that separates a `Promise` from its `resolve`/`reject` functions.
- [PowerTTLMap: Map with per-key TTL](guides/powerTTLMap.md). Lightweight `Map`-like store where keys expire lazily on access.

## Quick start

Requirements: Node.js and npm.

Install dependencies:

```bash
npm install
```

Install the package from npm for direct use in your project:

```bash
npm install --save performance-helpers
# or
yarn add performance-helpers
```

Run tests:

```bash
npm run test
```

Run coverage (v8):

```bash
npm run test:coverage
```

Build (Vite):

```bash
npm run build
```

Generate docs (Typedoc):

```bash
npm run docs
```

## Usage examples

Importing from the package entry (or directly from `src/helpers/*` during development):

```javascript
import { PowerCache, PowerMemoizer, PowerPool, PowerLogger, PowerThrottle, PowerSlidingWindow, PowerQueue, PowerDefer, PowerTTLMap, o2u8, u82o } from 'performance-helpers';
```

## CDN usage

You can import the package directly from a CDN for quick demos. Example using unpkg (ES module support):

```html
<script type="module">
  import { PowerMemoizer } from 'https://unpkg.com/performance-helpers@latest?module';
  const fetchUser = async (id) => fetch(`/users/${id}`).then((r) => r.json());
  const memo = new PowerMemoizer(fetchUser);
  console.log(await memo(1));
</script>
```

Or using jsDelivr:

```html
<script type="module">
  import { PowerCache } from 'https://cdn.jsdelivr.net/npm/performance-helpers@latest/dist/index.js';
  const cache = new PowerCache();
  cache.set('a', 1);
  console.log(cache.get('a'));
</script>
```

UMD example (script tag):

```html
<script src="https://unpkg.com/performance-helpers@latest/dist/performance-helpers.umd.js"></script>
<script>
  // UMD builds attach a global. Use the global that your build exposes.
  const lib = window.PerformanceHelpers;
  const { PowerCache } = lib || {};
  const cache = new PowerCache();
  cache.set('a', 2);
  console.log(cache.get('a'));
</script>
```


## License

[MIT](LICENSE.md).
