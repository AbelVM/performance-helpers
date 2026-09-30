[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / READY\_STATE

# Variable: READY\_STATE

> `const` **READY\_STATE**: `Readonly`\<\{ `CLOSED`: `3`; `CLOSING`: `2`; `CONNECTING`: `0`; `OPEN`: `1`; \}\>

The four states of a socket's lifecycle, as constants.

Defined here, in the one module every helper may import, so that
`PowerWebSocketClient` and `PowerSocketAdapter` hand back the _same_ frozen
object. They are separate helpers for separate directions - one dials out,
one wraps a socket somebody else accepted - and the adapter deliberately does
not import the client, because doing so would pull the whole reconnect
machinery into a server bundle. Duplicating the constant instead would have
been free of that cost and wrong in a subtler way: a user comparing the two
with `===` would get `false` for two identical-looking frozen objects, and the
only symptom would be a state check that silently never matches.

The values are the WebSocket standard's, so a socket's own `readyState` can be
compared against them directly.
