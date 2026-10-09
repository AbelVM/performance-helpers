[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSequencer](../README.md) / PowerSequencerOptions

# Interface: PowerSequencerOptions

## Properties

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../metrics/classes/MetricsCollector.md)

Opt in to metrics. See `guides/metrics.md`.

***

### onGap?

> `optional` **onGap?**: (`seq`, `missing`) => `void`

Called when a
  datagram arrives above the next expected sequence, so a gap exists. Receives
  the sequence that opened it and the full list of numbers now being waited
  on. Fired once per *newly opened* gap, not once per datagram that arrives
  inside an existing one.

#### Parameters

##### seq

`number`

##### missing

`number`[]

#### Returns

`void`

***

### onMessage?

> `optional` **onMessage?**: (`seq`, `payload`) => `void`

Called for each
  message released, in sequence order. A single `push()` can release several
  when it fills a gap that later datagrams were already waiting behind.

#### Parameters

##### seq

`number`

##### payload

`any`

#### Returns

`void`

***

### startAt?

> `optional` **startAt?**: `number`

The first sequence number expected. Set it
  when the peer's numbering does not start at zero.

***

### windowSize?

> `optional` **windowSize?**: `number`

How many sequence numbers ahead of the
  next expected one may be buffered. A datagram beyond the window is refused
  and counted in `stats().outOfWindow`, because buffering it would let a peer
  that jumped ahead grow this without limit.
