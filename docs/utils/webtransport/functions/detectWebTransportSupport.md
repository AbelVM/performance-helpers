[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [utils/webtransport](../README.md) / detectWebTransportSupport

# Function: detectWebTransportSupport()

> **detectWebTransportSupport**(`probe?`): [`WebTransportSupport`](../interfaces/WebTransportSupport.md)

Report what the current build supports for `WebTransport`.

**Pass a transport to learn about its instance surfaces.** Without one, the
instance-level fields — `datagrams`, `createWritable`, `stats`, `byob` — are
`false`, because the alternative is constructing a `WebTransport`, which opens
a connection. That is the deliberate trade: a probe that cannot be wrong
about a socket it never opened.

```javascript
const support = detectWebTransportSupport();
if (support.reliableOnly) {
  // Baseline only: safe to depend on.
}
```

## Parameters

### probe?

What to inspect. Defaults to `globalThis`.

#### transport?

\{ `datagrams?`: \{ `readable?`: `unknown`; `writable?`: `unknown`; \}; `getStats?`: () => `unknown`; `incomingHighWaterMark?`: `number`; \}

A live transport, used **read-only** for
  its `datagrams` and `getStats`. Nothing on it is called except `getStats`,
  and only to prove it works, not for its value.

#### transport.datagrams?

\{ `readable?`: `unknown`; `writable?`: `unknown`; \}

#### transport.datagrams.readable?

`unknown`

#### transport.datagrams.writable?

`unknown`

Deprecated and
  non-standard; presence only.

#### transport.getStats?

() => `unknown`

#### transport.incomingHighWaterMark?

`number`

#### WebTransport?

`Function`

The constructor to probe.

#### WebTransportSendGroup?

`Function`

The experimental group
  constructor, passed rather than read from the global so the function stays
  pure and testable.

## Returns

[`WebTransportSupport`](../interfaces/WebTransportSupport.md)

## Since

2.0.0
