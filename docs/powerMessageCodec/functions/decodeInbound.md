[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / decodeInbound

# Function: decodeInbound()

> **decodeInbound**(`data`): `object`

Read any message the pool can send, whatever carrier it arrived on.

This is the worker half of protocol negotiation, and it exists because the
three-way fallback it replaces was copy-pasted into every worker in the
wild — the try-the-frame-and-fall-back-to-bare-JSON dance, re-derived each
time and slightly differently each time.

Order matters and is not arbitrary:

1. A **native envelope** first. It is an object, so a byte test would not
   see it, but checking it first costs one property read.
2. Then a **framed message**, and only when its version byte claims version
   1. That is not sniffing either — it is the version check the frame format
   exists for. It is also what makes the fallback below safe to attempt on
   every message: no JSON document can start with `0x01`, so a legacy body
   can never be mistaken for a frame, and a version-2 frame still reports the
   version error it actually is.
3. Then a **legacy bare-JSON body**, for a pool still on `messageCodec:
   'legacy'`.

## Parameters

### data

`any`

`e.data`, or the payload of a bare `'message'` callback.

## Returns

`object`

### codec

> **codec**: `"json"` \| `"raw"` \| `"legacy"` \| `"native"`

### correlationId

> **correlationId**: `string` \| `undefined`

### value

> **value**: `any`

## Throws

When the input is a byte stream that is neither a valid
  frame nor valid JSON.
