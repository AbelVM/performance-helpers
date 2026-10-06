[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / [powerWebTransportClient](../README.md) / READY\_STATE

# Variable: READY\_STATE

> `const` **READY\_STATE**: `Readonly`\<\{ `CLOSED`: `3`; `CLOSING`: `2`; `CONNECTING`: `0`; `OPEN`: `1`; \}\>

The four states of a transport's lifecycle, as constants.

Mirrors `READY_STATE` from `powerWebSocketClient` so callers can compare
with `===` across both transports.
