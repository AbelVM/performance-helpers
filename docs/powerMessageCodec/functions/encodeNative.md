[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / encodeNative

# ~~Function: encodeNative()~~

> **encodeNative**(`value`): `object`

Encode a value for a `MessagePort` / `Worker` using the platform's structured
clone, with no framing and no serialization.

## Parameters

### value

`any`

## Returns

`object`

The message to pass to
  `postMessage` and the transfer list to pass alongside it. The list is empty
  when the value contains no transferable buffer.

### ~~message~~

> **message**: `any`

### ~~transfer~~

> **transfer**: `ArrayBuffer`[]

## Deprecated

**RT-023. Use [encodeNativeEnvelope](encodeNativeEnvelope.md) instead**, which does not
  clone. This function clones the value *and* hands the clone back for the caller
  to post — and `postMessage` then clones it again, because a transfer list only
  ever names buffers inside the object being posted and never replaces the clone.
  **So the common case pays for two deep copies where one suffices.** Measured on
  the real path (the encode, plus the clone `postMessage` performs), median of
  nine passes over 4 000 iterations, stable across three orderings: **~3 800 ns
  with this, ~260 ns with the envelope — about 14x** on a small object, with the
  extra clone ~95% of the cost. That is far outside the 28% median min/max spread
  BENCH-001 measures, so the direction and rough magnitude are solid even though
  the absolute figure is machine-specific: an earlier subagent measurement of the
  same defect read 50 µs on different hardware, and **the robust claim is the
  ratio, not either absolute number.**

  **Deprecated, not wrong — and one caller still needs it.** Posting binary
  without detaching the caller's data requires a private copy *and* a transfer
  list naming that copy's buffers, and this is the only call that returns both.
  `PowerPool._encodeNativeForWorker` uses it for exactly that case. If your
  message has no `ArrayBuffer` in it — the overwhelming majority — there is
  nothing to protect and the envelope is strictly better.

  This is the first `@deprecated` in the library, so the convention is set here:
  the tag names the replacement, and the body says what breaks if you ignore it.
  The export stays — removing it is a breaking change to the published surface,
  and the pool's own use would break with it.

This is the fast path for in-process boundaries — faster than the `json` frame
and lossless for `Map`, `Set`, `Date`, `RegExp`, cycles and binary. It is
*not* a byte stream, so it cannot be used over a WebSocket; use
[encodeMessage](encodeMessage.md) there.
