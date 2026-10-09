# PowerDeduplication

Time-windowed deduplicator. Tracks keys seen within a TTL window and prevents re-emitting/reprocessing the same key within that window.

## When to use

- Prevent duplicate messages/events (replays, reconnect storms)
- Deduplicate within a sliding time window
- Guard against rapid-fire duplicates

## Installation

```js
import { PowerDeduplication } from 'performance-helpers/powerDeduplication';
```

## API

### new PowerDeduplication(options)

Options: `{ ttl?: number, maxKeys?: number, now?: () => number }` or just `ttl` (number).

- `ttl` (number, ms): how long a key remains considered seen (default varies by impl usage; typically 60s). 0 means immediate expiry.
- `maxKeys` (number): maximum keys to track; when exceeded, evicts oldest.
- `now` (function): injected clock for testing.

### Methods

- `has(key)` — Returns true if key seen within TTL; otherwise marks key as seen and returns false.
- `mark(key)` — Marks key as seen regardless.
- `delete(key)` — Removes key.
- `clear()` / `reset()` — Clears all keys.
- `dispose()` / `[Symbol.dispose]()` / `[Symbol.asyncDispose]()` — Clears and marks disposed (subsequent has returns true).

### Properties

- `size` / `length` — Current tracked keys (pruned on read).
- `isEmpty()` — True if empty.

## Examples

```js
import { PowerDeduplication } from 'performance-helpers/powerDeduplication';

const dedup = new PowerDeduplication({ ttl: 1000 });
dedup.has('msg-1'); // false (mark)
dedup.has('msg-1'); // true (duplicate)
setTimeout(() => dedup.has('msg-1'), 1500); // false
```
