[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerDatagramChannel

# powerDatagramChannel

PowerDatagramChannel — a bounded, drop-counting wrapper for a datagram-style
transport (e.g. `RTCDataChannel`, `WebTransport` datagram stream).

## Why this exists

The hub's `send(sub, frame)` adapter contract assumes a transport that either
accepts a frame or refuses it permanently. Datagram transports do not fit that
shape: they have a *message-size ceiling* enforced by the platform, and when a
datagram exceeds it the platform either **throws** (`RTCDataChannel`) or
**silently discards** it with no signal to the sender.

The silent-discard case is the dangerous one. A caller that never learns a
datagram was dropped has no way to count the loss, and a hub that cannot count
drops cannot honour its slow-consumer contract. This class exists to make the
refusal **loud and countable**.

## What this is not

This is **not** a `PowerRealtimeHub` `send(sub, frame)` adapter. The hub's
`retain` feature and datagrams contradict each other: a retained message is a
framed JSON payload, while a datagram is an unframed binary blob. Wrapping a
datagram channel in a hub adapter would silently drop the `retain` guarantee
every time the platform discards an oversize datagram.

Use this class directly when you need bounded, counted datagram delivery, or
wrap it in your own adapter that knows how to frame and retain.

## The hard size check

`maxDatagramSizeBytes` is enforced **before** the platform sees the datagram.
An oversize datagram is refused with a `TypeError`, counted in
`stats().oversizeDatagrams`, and never handed to the underlying transport.
This is the opposite of the platform's silent-discard behaviour, and it is
the whole point of the class.

## Classes

- [PowerDatagramChannel](classes/PowerDatagramChannel.md)

## Interfaces

- [PowerDatagramChannelOptions](interfaces/PowerDatagramChannelOptions.md)
