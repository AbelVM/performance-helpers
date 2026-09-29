# W3C trace context through `PowerPool`

How to propagate a W3C `traceparent` across a `PowerPool` boundary — and why
it needs nothing from the library.

## The short version

`PowerPool` already round-trips a field you choose: the `correlationId` it
attaches for `awaitResponse`. A `traceparent` rides the same path. The pool
does not read it, strip it, or need to know what it is.

```js
// Caller
const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const reply = await pool.postMessage(
  { op: 'work', traceparent }, // you put it in
  undefined,
  { awaitResponse: true }
);

// Worker
import { decodeMessage, encodeMessage } from 'performance-helpers';

parentPort.on('message', (data) => {
  const { value } = decodeMessage(data);
  const span = startSpan(value.traceparent); // your tracer reads it
  parentPort.postMessage(
    encodeMessage({
      correlationId: value.correlationId, // echo it back
      result: span.end(),
    })
  );
});
```

Three lines on each side, and the pool is untouched.

## Why the library does not do this for you

It is worth being explicit, because "the pool should propagate my trace" is a
reasonable expectation and the answer is no.

**The pool does not interpret message content.** It encodes the envelope and
matches replies by `correlationId` — a field the _caller_ named. It has never
looked inside a payload for anything else, and adding a notion of a trace would
be the first time it did.

**A metadata channel in the envelope would break every hand-written worker.**
The frame is `[version][codec][length]` — a 6-byte header, `MESSAGE_PROTOCOL_VERSION`

1. Adding per-message metadata is a protocol bump and a wider header, and every
   worker reads those bytes by hand. See
   [adr/0001](../adr/0001-versioned-envelope-protocol.md) for the reasoning; the
   short version is that the 1.x decoder _guessed_ at message content and misparsed
   a payload that was valid as two different things. Growing a metadata concept
   into the pool moves toward that failure, not away from it.

**`AsyncLocalStorage` is a caller and worker concern.** The pool's parent process
cannot push context into a worker's async context — only a message can carry
it. So propagation is always something you do on each side, and the library's
job is to not stand in the way.

## Making it ergonomic

Two pieces of glue are worth having, and neither belongs in the pool:

```js
// Capture the current context once, at the edge.
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();

function withTrace(span, fn) {
  return als.run(span, fn);
}

function currentTrace() {
  return als.getStore();
}
```

```js
// In your worker, the entry point every handler goes through.
import { AsyncLocalStorage } from 'node:async_hooks';
const als = new AsyncLocalStorage();

parentPort.on('message', (data) => {
  const { value } = decodeMessage(data);
  als.run(value.traceparent, () => handle(value));
});

function handle(value) {
  // Anything downstream that calls currentTrace() sees this request's
  // traceparent, without it being passed down the call stack.
  trace(value.traceparent, () => doWork(value));
}
```

`als.run` per message is the whole trick. It is why context does not need to be
threaded through your own function signatures, and why the pool is irrelevant to
it: a worker is single-threaded, so one `run` scopes correctly across every
await inside the handler.

## What this costs

- **One extra field on the wire**, in the payload you already send.
- **The worker must echo what it needs.** `correlationId` only if you are using
  `awaitResponse`; `traceparent` if you are propagating.
- **A protocol bump only if you choose the metadata channel**, which this guide
  argues against. A payload field costs nothing outside your own process.

## When you would still want a library helper

If you run many pools and the `als.run` boilerplate repeats, wrap it — but wrap
it in _your_ code, over _your_ message shape, and keep the pool out of it. The
test that protects you is the same one that protects the pool: assert that a
message carrying an unknown field is delivered **unchanged**. A pool that
started consuming fields would break that the first time it learned a new one.

## See also

- [`powerPool.md`](powerPool.md) — the envelope, `awaitResponse`, and `correlationId`
- [`powerMessageCodec.md`](powerMessageCodec.md) — the framing this rides
- [adr/0001](../adr/0001-versioned-envelope-protocol.md) — why the pool does not read your payloads
