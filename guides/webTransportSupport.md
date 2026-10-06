# WebTransport feature detection

`detectWebTransportSupport()` answers one question: **what does this build actually support for `WebTransport`?** It is a pure function. No connection is opened, no constructor is called, and nothing is mutated.

That purity is the whole design constraint, and it is why the answer has two parts. Several of the surfaces worth detecting are _instance_ attributes of a live `WebTransport`, so asking "does this build support them" without a transport means answering `false` for them — and saying so is better than opening a socket to find out.

```javascript
import { detectWebTransportSupport } from 'performance-helpers';

const support = detectWebTransportSupport();

if (!support.available) {
  // No WebTransport constructor at all. Everything else is meaningless.
} else if (support.reliableOnly) {
  // Every surface reported is Baseline. Safe to depend on.
} else {
  // Something non-Baseline is present. Branch on the individual fields.
}
```

## The one flag to branch on

`reliableOnly` is the conservative answer: it is `true` only when **every** surface this build exposes is Baseline, so gating a code path on it is safe on any engine the project supports.

It is computed as `!sendGroups && !statsPresent`, from the detected fields rather than from a table — so adding a field later cannot leave it stale. That is the property that matters, because a flag that reads "safe" while computed from a list that has drifted is worse than no flag.

**Prefer it over checking fields yourself** unless you specifically want a non-Baseline surface, because the individual fields describe what exists, not what you should build on.

## Three surfaces are not Baseline

| field            | availability                               | what it means                                       |
| ---------------- | ------------------------------------------ | --------------------------------------------------- |
| `reliability`    | **Limited**                                | Not Baseline                                        |
| `stats`          | **Limited** — `getStats()` is not Baseline | Availability stats on the transport                 |
| `sendGroups`     | **Experimental**                           | `WebTransportSendGroup` exists                      |
| `datagrams`      | Baseline                                   | A datagram duplex stream on the inspected transport |
| `createWritable` | Baseline, with a caveat                    | The datagram stream is writable                     |
| `byob`           | Baseline                                   | BYOB datagram reads are available                   |

A detector that reported the optimistic answer for the first three would be the more dangerous kind of wrong: you would branch on a surface that is not there, get `undefined`, and discover it as a `TypeError` somewhere unrelated. So **each defaults to `false` on absence and never to `true`**, and `reliableOnly` is `false` whenever any non-Baseline surface is in play.

That is the flag you want if you would rather branch on a promise than on a fact.

## Presence and usability are tracked separately

`stats` is `true` only when `getStats()` was **called and returned** something. `getStats` is Limited availability, which means a build can expose the name and throw from it — so presence alone is not enough to tell a caller it can rely on the call.

But a `getStats` that _throws_ is still a non-Baseline surface, and a build carrying one is not a build to gate on. So `reliableOnly` is computed from **presence**, not from usability: reporting `reliableOnly: true` for a build whose `getStats` throws would invite exactly the branch this is meant to prevent.

Concretely: `stats` is false and `reliableOnly` is false when `getStats` throws; `stats` is true and `reliableOnly` is false when it works, because it is still not Baseline.

## Detecting the instance surfaces

Pass a live transport to learn about `datagrams`, `createWritable`, `stats` and `byob`. It is used **read-only** — nothing on it is called except `getStats`, and only to prove it works, not for its value.

```javascript
const transport = new WebTransport(url, { createBidirectionalStreams: true });
const support = detectWebTransportSupport({ transport });

if (support.datagrams && support.createWritable) {
  // datagrams can be written
}
```

**Without a transport those four fields are `false`**, not "unknown" — the shape does not grow an `unknown`, because a build with no constructor cannot have a transport and `available: false` already says everything else is meaningless.

The `probe` argument also accepts `WebTransport` and `WebTransportSendGroup` directly, so the function stays pure and testable without touching a global:

```javascript
detectWebTransportSupport({ WebTransport: FakeCtor, WebTransportSendGroup: undefined });
```

## `createWritable` and the deprecated spelling

The writable side of the datagram stream is `transport.datagrams.writable`, which MDN marks **deprecated and non-standard** — and most examples in circulation still use it.

This reports it as _present_, because a browser that has only the deprecated spelling genuinely can create the stream, and detecting its absence is still useful: a build without it cannot write datagrams at all. Read the field as **"datagrams can be written"**, not as a spelling to depend on.

## `byob` is a capability, not a constructor

There is no `WebTransportByob` to test for. The signal is that the transport reports an `incomingHighWaterMark` — the option that applies to BYOC reads — **and** exposes a readable datagram stream.

The mark is read from the **transport**, not from `datagrams`. It does not live on the stream, and an earlier version of this detector looked there, so it reported `byob` only when a transport did _not_ have it. That inversion is the reason the check is spelled out here.

## API

- `detectWebTransportSupport(probe?)` → frozen `WebTransportSupport`. `probe` defaults to `globalThis` and may carry `WebTransport`, `WebTransportSendGroup` and `transport`.

The returned object is `Object.freeze`d. It is a plain data snapshot, not a live view — re-call it if you construct a new transport and want the instance surfaces again.

## See also

- [`PowerWebTransportAdapter`](powerWebTransportAdapter.md) — the `kind: 'stream'` socket adapter that wraps a `WebTransport` session's `createBidirectionalStream()` for `PowerRealtimeHub`.
- [`PowerRealtimeHub`](powerRealtimeHub.md) — transport-agnostic fan-out; the adapter supplies its `send`.
- [`PowerSocketAdapter`](powerSocketAdapter.md) and [`PowerWebSocketClient`](powerWebSocketClient.md) — the WebSocket path, which is what you fall back to when `available` is `false`.
- [`troubleshooting.md`](troubleshooting.md) — for the `SharedArrayBuffer` and cross-origin-isolation questions that decide whether a `WebTransport` connection can be established at all.
