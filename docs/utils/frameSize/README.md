[**performance-helpers**](../../README.md)

***

[performance-helpers](../../README.md) / utils/frameSize

# utils/frameSize

Byte length of a frame, whichever of the shapes a platform hands us.

Shared by `PowerWebSocketClient` and `PowerSocketAdapter` because the two
helpers normalise different socket models and receive different shapes from
each: a `message` event carries a `Blob` for binary frames by default and an
`ArrayBuffer` or `Uint8Array` once `binaryType` is set, a Node `ws` socket
hands a `Buffer`, and a `WebSocketStream` reader yields a `Uint8Array`. All of
them expose a length synchronously, so the check a payload limit needs is
always non-blocking — which is the property that lets the limit be a check at
all rather than an awaited `arrayBuffer()` per frame.

It lives here rather than in either helper for the reason `READY_STATE` lives
in `constants.js`: the adapter deliberately does not import the client, so a
caller comparing behaviour across the two would otherwise be comparing two
copies that are free to drift. `PowerSocketAdapter` is the server-side
counterpart and pulling the client's reconnect machinery into a server bundle
to borrow eight lines is not a trade worth making.

## Functions

- [frameByteLength](functions/frameByteLength.md)
