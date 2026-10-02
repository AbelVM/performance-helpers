[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/webtransport](../README.md) / WebTransportSupport

# Interface: WebTransportSupport

## Properties

### available

> **available**: `boolean`

A `WebTransport` constructor exists at all.
  Everything else is meaningless when this is `false`.

***

### byob

> **byob**: `boolean`

BYOB datagram reads are available: the incoming
  high-water mark is reported, which is what distinguishes a BYOB-capable
  build from one that only queues whole datagrams.

***

### createWritable

> **createWritable**: `boolean`

The datagram stream is writable.
  Detected from `transport.datagrams.writable`, which is **deprecated and
  non-standard**; treat presence as "datagrams can be written", not as a
  spelling to depend on.

***

### datagrams

> **datagrams**: `boolean`

A datagram duplex stream is available on the
  inspected transport. `false` without one (see the note on passing one).

***

### reliableOnly

> **reliableOnly**: `boolean`

**Every** surface reported here is
  Baseline, so gating a code path on this object is safe on any engine the
  project supports. `false` whenever `stats` or `sendGroups` is present,
  because both are non-Baseline — which is the intended use: this is `true`
  only for the conservative subset.

***

### sendGroups

> **sendGroups**: `boolean`

`WebTransportSendGroup` exists.
  **Experimental** — defaults to `false`, and `reliableOnly` is `false` while
  it is present.

***

### stats

> **stats**: `boolean`

`getStats()` is available on the transport.
  **Limited availability** — defaults to `false`, and `reliableOnly` is
  `false` while it is present.
