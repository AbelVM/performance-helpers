# Realtime

Transport framing and real-time fan-out. These compose: the hub delivers over
whatever transport you supply, and the codec is what makes a batch of messages
legible to the receiver.

- [PowerMessageCodec: Versioned binary message framing](../guides/powerMessageCodec.md). Explicit `[version][codec][length][payload]` envelope so a transport never has to _guess_ what it received. Framed `json`/`raw` codecs for byte streams, plus `encodeNative` for the platform structured clone on a `MessagePort`/`Worker`. This is the protocol `PowerPool` speaks by default since 2.0.
- [PowerRealtimeHub: Topic fan-out with slow-consumer control](../guides/powerRealtimeHub.md). Per-subscriber bounded queues and a declared policy (`drop-oldest` / `drop-newest` / `disconnect`) so one slow consumer cannot stall or OOM the process. Transport-agnostic via a `send` adapter; batches over `PowerMessageCodec`.
