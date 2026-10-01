[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_CIRCUIT\_MAX\_OPEN\_FACTOR

# Variable: DEFAULT\_CIRCUIT\_MAX\_OPEN\_FACTOR

> `const` **DEFAULT\_CIRCUIT\_MAX\_OPEN\_FACTOR**: `16` = `16`

How many times a circuit's open window may double before it is capped.

`PowerCircuit` opens for `baseTimeout`, then `2x`, then `4x`… up to
`baseTimeout * 16`, so a dependency that is genuinely down stops being probed
at a rate that cannot itself keep it down, while one that recovers after a
brief blip is not locked out for minutes.
