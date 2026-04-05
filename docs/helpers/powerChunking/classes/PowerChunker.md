[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerChunking](../README.md) / PowerChunker

# Class: PowerChunker

PowerChunking helper (class `PowerChunker`)

Construct with `new PowerChunker(iterable, fn, options)` to create a
helper that heuristically chunks an iterable and runs `fn` for every item
inside lightweight inline worker-like instances managed by a `PowerPool`.
The constructor returns the created `PowerPool` instance so callers can
interact with it (listen `onmessage`, call `drain()`, `terminate()`, etc.).

Usage:
```js
const pool = new PowerChunker(iterable, fn, options);
pool.onmessage = (e) => { // handle per-chunk results };
await pool.drain();
```

Notes:
- This helper creates lightweight inline worker-like instances that execute
  `fn(item, index, chunk)` on each chunk element asynchronously (via
  setTimeout) so tests and environments without real Worker support still work.
- For heavy CPU work prefer a real Worker source string and create your own
  `PowerPool` instead; this helper focuses on convenience and correctness.

## Param

Input iterable of items to process.

## Param

Function to call for each item: `(item, index?, chunk?) => void`.

## Param

## Param

Options forwarded to `PowerPool` constructor.

## Param

Options forwarded to `postMessageBatch`.

## Param

Explicit chunk size to use. When omitted a heuristic is used.

## Param

Hint about `fn` complexity to bias chunking. When omitted the helper
  will attempt to analyze `fn`'s source to infer a complexity score ('light'|'medium'|'heavy') and use that
  to bias the chunk size. If analysis fails the helper falls back to 'medium'.

## Constructors

### Constructor

> **new PowerChunker**(`iterable`, `fn`, `options?`): `PowerChunker`

#### Parameters

##### iterable

`any`

##### fn

`any`

##### options?

#### Returns

`PowerChunker`
