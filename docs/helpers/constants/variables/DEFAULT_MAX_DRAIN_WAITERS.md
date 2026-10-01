[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_MAX\_DRAIN\_WAITERS

# Variable: DEFAULT\_MAX\_DRAIN\_WAITERS

> `const` **DEFAULT\_MAX\_DRAIN\_WAITERS**: `100` = `100`

Ceiling on how many `PowerPool.drain()` calls may be *waiting* at once.

`drain()` registers an `idle` listener, so N concurrent drains are N
listeners and N closures retained until the pool next goes idle. A caller
that drains in a loop - once per request, say - accumulates them without
bound and eventually trips `MaxListenersExceededWarning`. 100 is far above any
deliberate use and low enough to stay under Node's default warning threshold
of 10 per emitter only if the caller also raises `maxListeners`; the honest
behaviour is to refuse the overflow and say so.
