# 0008. `send()` throws for a permanent refusal and returns `false` for a transient one

**Status:** Accepted
**Affects:** `PowerRTCChannel` (`src/helpers/powerRTCChannel.js`), `PowerRealtimeHub`'s `send(sub, frame)` adapter contract, and `unsendableFrameError` in `src/utils/errors.js`
**Evidence:** `test/powerRTCChannel.hub.test.js`, `test/powerRTCChannel.test.js`, MDN's `RTCDataChannel.send()` exceptions, WebRTC 1.0 §5.6.1. No benchmark: this is an API-shape decision, not a performance claim.

## Context

RT-017 scoped `PowerRTCChannel` as a transport adapter onto `PowerRealtimeHub`'s
`send(sub, frame)` shape. The row named four facts about `RTCDataChannel`; all
four were checked against MDN and the WebRTC 1.0 spec before any code was
written, and two of them changed the design.

Two held as written: `binaryType` really does default to `arraybuffer` (so
RT-002's fix is _not_ repeated), and `bufferedamountlow` really is a push signal.
One held with a wrong citation — `ordered:false, maxRetransmits:0` is real, but
RFC 8831 is RTP _media_ transport and says nothing about data channels; the
semantics are WebRTC 1.0's and the wire format is RFC 8841.

The omission that mattered was this: **a `WebSocket` and a data channel differ in
what an oversize frame does.** `WebSocket.send()` buffers and the connection
merely slows. `RTCDataChannel.send()` **throws** above the negotiated SCTP message
size, because SCTP caps a single message. The row described RTC's back-pressure
as _better_ than the socket's and said nothing about this.

That turns out to govern the whole method.

## The problem

`PowerRealtimeHub` increments `stats().delivered` **before** calling a
`send(sub, frame)` adapter, and invokes the subscriber's handler on the success
path of whatever the adapter returned. A **throw** is routed to `onError` and
leaves the batch uncounted. A **`false`** is neither — it is not a rejection, so
it reads as success.

`PowerSocketAdapter.send()` returns `false` for "not now", which is correct for
it: its `maxPayloadSizeBytes` is a limit on frames the platform has **already
received and buffered**, so it is observability rather than a guard, and its
docblock says so.

An outbound size limit is the opposite. The check happens _before_ `send()`, so
it genuinely prevents. And a refusal there is permanent: no amount of retrying
makes a frame smaller, so a caller looping on `false` would spin on it forever.

So the two refusals are different in kind, and only one of them is observable.

## Decision

- **Not open → `false`.** Transient, consistent with `PowerSocketAdapter`, and
  correct: an `onError` per frame during every connect race is noise that trains
  a caller to ignore the handler.
- **Over the message-size ceiling → `throw`.** Permanent, and the only outcome a
  hub can observe.

The awkward corollary is documented rather than engineered around: **a hub
cannot see a `false`.** A frame published while the channel is connecting is
refused by the transport _and delivered to the consumer anyway_. `PowerSocketAdapter`
has the identical property. `stats().sendRefusals` is therefore a counter rather
than a comment, and the guide tells hub callers to watch it.

## Consequences

- **`unsendableFrameError` is a second factory, not a reuse.** `oversizedFrameError`'s
  sentence — "detection, not prevention — the frame was already received and
  buffered" — is true inbound and _false_ here. Reusing it would tell someone
  debugging a refused send that their oversized frame had gone out on the wire.
  The `code` is deliberately the same (`'ERR_FRAME_TOO_LARGE'`) so one `onError`
  handler filters both directions; a second code would force every caller to
  write two handlers for one condition. A test pins both messages against being
  merged.
- **`maxMessageSizeBytes` accepts `Infinity`**, delegating the check to the
  platform's own throw, where the other two helpers' equivalent option does not.
  Those describe an inbound limit on frames the platform has already accepted.
- **The default is the negotiated figure**, `RTCSctpTransport.maxMessageSize`, with
  a 256 KiB fallback (Chrome's value) where the platform exposes none. The
  fallback errs _high_ deliberately: too low refuses frames the channel would have
  carried, too high produces a visible error rather than a silent refusal.
- **`PowerRTCChannel` cannot make a channel UDP-like.** `ordered` and
  `maxRetransmits` are fixed by `createDataChannel()`. A helper reporting
  "UDP-like" while silently accepting the _default_ reliable channel would make
  every latency claim built on that assumption false with nothing to say so, so
  `expectUnreliable` makes the configuration a checked assertion and `stats()`
  reports what the channel actually is.

## Appendix: four defects the tests found

All four were found by tests, not by reading the code, and all four are the same
mistake: **a state machine with states documented but not wired.** That is the
shape worth remembering — a table listing four states is not evidence that four
states are handled.

| Defect                                                                | How it was found                                                                       | Consequence if shipped                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| An `open` event after `close` reopened the channel                    | `fast-check` property over interleaved events: `stats().closed` read 2 for one closure | A peer table that tears down on `closed` double-frees                                                                   |
| No `closing` listener, though the module's own table listed `closing` | The state-transition test                                                              | A closing channel reported `OPEN`; every frame during teardown produced a spurious `onError`                            |
| `isBackpressured` never cleared on close                              | RT-018's trap, re-derived                                                              | Flag stuck `true` forever with no event coming — RT-018's infinite stall reached through the flag instead of the number |
| `readyState` read unguarded at construction                           | The detached-channel test                                                              | Construction throws on exactly the transferred channel the helper exists to serve                                       |

Eight mutants were then injected and all eight killed — including a first attempt
at the detached-channel mutant that produced a **syntax error** and therefore
tested the parser rather than the guard. A mutant that fails for the wrong reason
is the mutation-testing version of a test that cannot fail: it reports a kill
without having demonstrated anything.

## Appendix: how this work reached `HEAD` mislabelled

The first three defects above were found _after_ the first version of this helper
had already been committed inside `81fbe8d`, a `refactor:` commit about
`dispose()` methods in ten unrelated files. The cause was `git add -- src/helpers/`
— the directory form, which is `-A`-scoped to one folder — sweeping up a file
that was still being edited. This is the fifth occurrence AGENTS.md records for
that habit, and the first where the swept-in work belonged to the same session
that wrote it, so the diff looked like a colleague's rather than a snapshot of
work in progress.

Two consequences, both worth stating because they are the reason the fixes went
in a follow-up commit rather than an amend:

- **`HEAD` holds a version with two of these defects.** The `closing` listener is
  absent and the back-pressure flag is not cleared on close. A clean checkout of
  `81fbe8d` therefore contains a helper whose own docblock describes behaviour the
  code does not have.
- **The history is not rewritten to fix it.** AGENTS.md is explicit that the
  changeset, not the commit message, is the artefact that survives a misleading
  commit, and rewriting shared history to correct a message would trade a
  documentation defect for a worse one. The fixes land in one commit that says
  plainly what it contains, and the changeset carries the record.

The generalisable part: a guard this class needs was invisible because the file
had already left the working tree. **Nothing about a commit tells you which of its
files were still in progress**, so a test that passes locally says nothing about
whether the version under review is the version you tested.
