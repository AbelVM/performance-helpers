[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_RETRY\_BUDGET\_RATIO

# Variable: DEFAULT\_RETRY\_BUDGET\_RATIO

> `const` **DEFAULT\_RETRY\_BUDGET\_RATIO**: `0.2` = `0.2`

Default retry-budget ratio: the fraction of ordinary requests that may be
retried before the budget refuses more.

Google SRE Workbook, _Handling Overload_ (2018) puts the recommended band at
10-20 % of total requests; the top of that band is the default because a
budget exists to stop an amplification loop, not to ration retries in normal
operation. Every retry is a request the dependency did not ask for, and at
5 % the protection would start refusing retries while the dependency is
merely degraded rather than down.
