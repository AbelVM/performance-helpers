[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / BACKWARD\_CLOCK\_TOLERANCE

# Variable: BACKWARD\_CLOCK\_TOLERANCE

> `const` **BACKWARD\_CLOCK\_TOLERANCE**: `3` = `3`

Consecutive backwards clock observations before `PowerThrottle` accepts a
regressed clock (AUD-037).

A *transient* backwards step must be ignored — preserving the last valid
reading is the safe direction, and crediting the jump would hand out tokens
for time that did not pass. A *permanent* one must eventually be accepted, or
`elapsedMs` stays `0` forever and the throttle never refills again.

The threshold is a count of consecutive observations rather than a duration
because the question is whether the regression is *sustained*: any forward
step resets the counter, so a clock that jitters backwards once in a while
never reaches it. Three is small enough that a genuinely stuck clock recovers
within a handful of calls, and large enough that an NTP correction which
corrects itself on the next observation never trips it.
