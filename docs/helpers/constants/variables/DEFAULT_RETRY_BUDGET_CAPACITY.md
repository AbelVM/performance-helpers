[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_RETRY\_BUDGET\_CAPACITY

# Variable: DEFAULT\_RETRY\_BUDGET\_CAPACITY

> `const` **DEFAULT\_RETRY\_BUDGET\_CAPACITY**: `10` = `10`

Default retry-budget capacity, in retry tokens.

This is a *burst* allowance, not the steady-state rate - the steady state is
`ratio` tokens per original request, so a budget of ratio 0.2 that refills
to 10 permits ten consecutive retries before it throttles to one per five
requests. Sized so a short blip is absorbed without a budget check, and so
the cap on the token count is not what decides when protection engages: a
capacity of 1 would refuse the first retry of a fresh budget, because one
request funds 0.2 of a token and a retry costs a whole one.
