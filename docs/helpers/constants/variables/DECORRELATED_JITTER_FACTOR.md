[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DECORRELATED\_JITTER\_FACTOR

# Variable: DECORRELATED\_JITTER\_FACTOR

> `const` **DECORRELATED\_JITTER\_FACTOR**: `3` = `3`

The growth factor for the decorrelated-jitter backoff.

AWS, *Exponential Backoff and Jitter* (2015): the next sleep is drawn from
`random(base, previous * 3)`. The three is the paper's, and it is the whole
reason the strategy decorrelates: each attempt randomises against the
*actual* previous sleep rather than against a formula, so two clients that
started together drift apart instead of marching in step.
