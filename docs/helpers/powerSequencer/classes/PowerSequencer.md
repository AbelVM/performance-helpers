[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerSequencer](../README.md) / PowerSequencer

# Class: PowerSequencer

In-order reassembly over an out-of-order datagram transport.

Owns no timer and no listener registry — it is a pure state machine driven by
`push()`. So `dispose()` is a **state reset**, not a teardown: there is
nothing to cancel, and the interface exists so the helper can take part in
`using` / `await using` like every other long-lived helper here.

## Example

```ts
const seq = new PowerSequencer({
  windowSize: 128,
  onGap: (s, missing) => sendNack(missing),
  onMessage: (s, payload) => handle(s, payload),
});

channel.addEventListener('message', (e) => seq.push(e.seq, e.payload));
```

## Constructors

### Constructor

> **new PowerSequencer**(`options?`): `PowerSequencer`

#### Parameters

##### options?

`number` \| [`PowerSequencerOptions`](../interfaces/PowerSequencerOptions.md)

#### Returns

`PowerSequencer`

## Properties

### \_buffer

> **\_buffer**: `Map`\<`number`, `any`\>

***

### \_delivered

> **\_delivered**: `number`

***

### \_disposed

> **\_disposed**: `boolean`

***

### \_duplicates

> **\_duplicates**: `number`

***

### \_gapsOpened

> **\_gapsOpened**: `number`

***

### \_metrics

> **\_metrics**: \{ `name`: `string`; `unregister`: () => `boolean`; \} \| `null`

***

### \_next

> **\_next**: `number`

***

### \_onGap

> **\_onGap**: ((`seq`, `missing`) => `void`) \| `null`

***

### \_onMessage

> **\_onMessage**: ((`seq`, `payload`) => `void`) \| `null`

***

### \_outOfWindow

> **\_outOfWindow**: `number`

***

### \_startAt

> **\_startAt**: `number`

***

### \_windowSize

> **\_windowSize**: `number`

## Accessors

### buffered

#### Get Signature

> **get** **buffered**(): `number`

How many datagrams are buffered ahead of the gap.

##### Returns

`number`

***

### nextExpected

#### Get Signature

> **get** **nextExpected**(): `number`

The next sequence number that will be released.

##### Returns

`number`

## Methods

### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### \[dispose\]()

> **\[dispose\]**(): `void`

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Alias for [PowerSequencer#reset](#reset).

#### Returns

`void`

***

### dispose()

> **dispose**(): `void`

#### Returns

`void`

***

### getStats()

> **getStats**(): `object`

Alias for [PowerSequencer#stats](#stats), matching the rest of the library.

#### Returns

`object`

***

### missing()

> **missing**(): `number`[]

Sequence numbers currently being waited on, ascending.

This is the list a NACK would carry. It is derived from the buffer rather
than stored, so it cannot drift out of step with what is actually held.

#### Returns

`number`[]

***

### push()

> **push**(`seq`, `payload`): `boolean`

Accept one datagram.

#### Parameters

##### seq

`number`

The datagram's sequence number. Must be a finite
  integer; a fractional or non-finite value is refused rather than coerced,
  because `Math.floor` would silently renumber the stream.

##### payload

`any`

The datagram's payload, handed to `onMessage` when
  the datagram is released.

#### Returns

`boolean`

Whether the datagram was accepted into the window. A
  duplicate or an out-of-window datagram returns `false` and is counted;
  neither is buffered.

***

### reset()

> **reset**(): `void`

Discard all buffered state and resume from `startAt`.

A state reset, not a teardown: this helper owns no timer and no listener
registry, so there is nothing to cancel. The interface exists so it can
take part in `using` / `await using` like every other long-lived helper
here.

#### Returns

`void`

***

### stats()

> **stats**(): `object`

#### Returns

`object`

Counters. `delivered` is messages released in order,
  `duplicates` and `outOfWindow` are refusals, and `gapsOpened` counts
  distinct gaps rather than datagrams that arrived inside one.
