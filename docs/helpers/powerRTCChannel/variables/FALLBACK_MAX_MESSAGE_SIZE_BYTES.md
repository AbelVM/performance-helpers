[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerRTCChannel](../README.md) / FALLBACK\_MAX\_MESSAGE\_SIZE\_BYTES

# Variable: FALLBACK\_MAX\_MESSAGE\_SIZE\_BYTES

> `const` **FALLBACK\_MAX\_MESSAGE\_SIZE\_BYTES**: `number`

Fallback message-size ceiling when the platform does not expose one.

`RTCSctpTransport.maxMessageSize` is the real negotiated figure and is what
PowerRTCChannelOptions.maxMessageSizeBytes defaults to whenever the
platform reports it. When it does not — an older browser, a detached channel,
a test double — this is Chrome's value.

**The direction of the error matters and this picks it deliberately.** Guessing
too *low* refuses frames the channel would have carried; guessing too *high*
lets `send()` throw, which this class catches and reports through `onError`.
So the fallback errs high, and the failure it can cause is a visible error
rather than a silent refusal.
