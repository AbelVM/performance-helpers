[**performance-helpers**](../README.md)

***

[performance-helpers](../README.md) / powerRealtimeHub

# powerRealtimeHub

Topic fan-out with per-subscriber bounded queues and an explicit
slow-consumer policy.

The naive way to push to a set of clients is `for (const ws of clients)
ws.send(payload)`. That fails in two ways that only show up in production:

1. **A slow consumer stalls everyone.** One client's TCP buffer fills, the
   socket's `send` starts buffering without bound, and that client's backlog
   consumes the memory of the whole process. Eventually the server dies for
   everyone because of one bad connection.
2. **Nothing tells you it happened.** There is no signal that a client has
   fallen behind, so you cannot shed load deliberately.

This hub gives every subscription its own bounded queue and a *declared*
policy for when that queue fills. A slow consumer is then a bounded,
observable, per-subscriber problem instead of a process-wide one.

## Transport-agnostic

The hub does not know about WebSockets. You supply a `send(subscriber,
frame)` adapter, so it works with a `WebSocket`, a Node `ws` socket, a
`MessagePort`, a `TransformStream` writer, or a test spy. Messages are
encoded with PowerMessageCodec, so several can be batched into one
send without the receiver having to guess where the boundaries are.

## Classes

- [PowerRealtimeHub](classes/PowerRealtimeHub.md)

## Interfaces

- [HubOptions](interfaces/HubOptions.md)
- [HubStats](interfaces/HubStats.md)
- [HubSubscriber](interfaces/HubSubscriber.md)
- [HubSubscriberStat](interfaces/HubSubscriberStat.md)
- [SubscriberOptions](interfaces/SubscriberOptions.md)

## Type Aliases

- [SlowConsumerPolicy](type-aliases/SlowConsumerPolicy.md)

## References

### default

Renames and re-exports [PowerRealtimeHub](classes/PowerRealtimeHub.md)
