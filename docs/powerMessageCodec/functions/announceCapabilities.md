[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerMessageCodec](../README.md) / announceCapabilities

# Function: announceCapabilities()

> **announceCapabilities**(`options?`): `object`

Build the message a worker posts to advertise the carriers it can decode.

Post it once, on start-up, before or with the worker's first reply. The pool
records it per worker and posts the native carrier to that worker from the
next message on; every other worker keeps receiving the framed JSON.

## Parameters

### options?

#### codecs?

`string`[]

Carriers this worker
  can decode. `json` is always safe to claim: it is what the pool sends
  until the announcement arrives, so a worker that decodes frames must not
  claim anything else instead.

## Returns

`object`

### \_\_pp

> **\_\_pp**: `1`

### codecs

> **codecs**: `string`[]

### kind

> **kind**: `"capabilities"`

### protocol

> **protocol**: `number`
