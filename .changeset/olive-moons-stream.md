---
'performance-helpers': patch
---

Adds the measurement that closes FEAT-012's streaming half without building it.

`node bench/claims.js stream` compares posting a payload in one message against
pushing the same payload through a `TextEncoderStream` in pieces and
reassembling it — the work a chunked protocol would require.

| payload | chunks | one message |   streamed | reassemble | total |
| ------- | -----: | ----------: | ---------: | ---------: | ----: |
| 16 KB   |      1 |     15.7 µs |   226.6 µs |     2.0 µs | 14.6× |
| 64 KB   |      1 |     87.9 µs |   598.6 µs |    17.4 µs |  7.0× |
| 256 KB  |      4 |    252.0 µs |  2530.4 µs |    13.4 µs | 10.1× |
| 1024 KB |     16 |    800.0 µs | 10280.0 µs |    59.3 µs | 12.9× |

No size pays, and the gap is not stream overhead — it is that there is nothing
to stream _for_. Streaming is a bandwidth discipline: it exists because a link
delivers bytes progressively and a consumer that needs all of them would rather
start than wait. A `Worker` port is not a link. The payload is already resident
in this process's memory, `postMessage` hands over its `ArrayBuffer` by transfer
rather than by copy, and there is no slow producer on the far side for
backpressure to apply to. A chunked protocol would add an envelope shape, an
ordering and completeness contract, and a reassembly buffer, to arrive at the
same bytes.

Where a payload genuinely does arrive in pieces — a file, a `fetch` body, a
`WebSocket` — the caller already has a `ReadableStream`, and `PowerMessageCodec`
already reads frames off one. That is where the capability lives, and it shipped
in 2.0.

This is the same structural finding as FEAT-013 (compression) in the same
session: a proposal to optimise a transport that does not charge for what the
optimisation saves.
