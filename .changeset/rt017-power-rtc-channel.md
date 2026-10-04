---
'performance-helpers': minor
---

Add `PowerRTCChannel` — one `RTCDataChannel` behind the same shape as `PowerSocketAdapter`, for use as a `PowerRealtimeHub` transport.

RT-017's four premise claims were verified against MDN and the WebRTC 1.0 spec before any code was written. Two held as written, one held with a wrong citation, and the difference that mattered most was missing.

`RTCDataChannel.readyState` is the **string** `'open'`, while `READY_STATE.OPEN` is `1` — so the guard every other transport in this library satisfies, and that this library's own code is full of, is silently false on a healthy channel, with no error to trace. The class reads that string once and maintains a numeric copy from events. Reading it once is a requirement rather than an optimisation: getting `readyState` on a **detached** channel (one transferred to another realm) throws, and a transferred channel is exactly what this helper exists to serve.

`bufferedAmountLowThreshold` + `bufferedamountlow` are real, and the row was right that the client's `bufferedAmount` poll emulates a signal a data channel pushes. What the row did not say is what that costs the caller: `PowerWebSocketClient` needs four watermark options and a backing-off timer for it. This needs one option, no timer, and a boolean read — `highWaterMarkBytes` is written to the platform's own threshold, and `isBackpressured` is raised by `send()` and cleared by the event.

The omission that governed the API shape: **a `WebSocket` buffers an oversize frame and gets slower; a data channel throws**, because SCTP caps a single message. So `send()` has two refusals that must differ. Not open returns `false` — transient, consistent with `PowerSocketAdapter`, and correct, since an `onError` per frame during a connect race is noise. Over the SCTP ceiling it **throws**, because `PowerRealtimeHub` increments `delivered` before calling its `send` adapter and reports failure only through a throw: an adapter that refused by returning `false` would lose the frame with `delivered` already incremented. The ceiling defaults to the negotiated `RTCSctpTransport.maxMessageSize` and is enforced, not reported — the opposite of the inbound `maxPayloadSizeBytes` on the two socket helpers, and `unsendableFrameError` exists as a second message for that reason rather than reusing a sentence that is false outbound.

Two claims from the row are corrected in the docs: the citation (RFC 8831 is RTP media transport and says nothing about data channels; the semantics are WebRTC 1.0's and the wire format RFC 8841's), and the implication that this helper delivers UDP-like semantics. It cannot — `ordered` and `maxRetransmits` are fixed by `createDataChannel()` — so `expectUnreliable` asserts the configuration and `stats()` reports what the channel actually is. `binaryType` is genuinely `arraybuffer` by default, so RT-002's fix is not repeated; `stats().binaryType` reports it rather than assuming it holds.

Also closes RT-018's outstanding half: the `bufferedAmount`-after-close trap, documented in the new guide for this transport and gated in the adapter. A producer reading `dc.bufferedAmount` directly waits on a figure that never falls.

No changes to existing helpers beyond the shared `errors.js` gaining one factory.
