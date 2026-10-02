/**
 * Byte length of a frame, whichever of the shapes a platform hands us.
 *
 * Shared by `PowerWebSocketClient` and `PowerSocketAdapter` because the two
 * helpers normalise different socket models and receive different shapes from
 * each: a `message` event carries a `Blob` for binary frames by default and an
 * `ArrayBuffer` or `Uint8Array` once `binaryType` is set, a Node `ws` socket
 * hands a `Buffer`, and a `WebSocketStream` reader yields a `Uint8Array`. All of
 * them expose a length synchronously, so the check a payload limit needs is
 * always non-blocking — which is the property that lets the limit be a check at
 * all rather than an awaited `arrayBuffer()` per frame.
 *
 * It lives here rather than in either helper for the reason `READY_STATE` lives
 * in `constants.js`: the adapter deliberately does not import the client, so a
 * caller comparing behaviour across the two would otherwise be comparing two
 * copies that are free to drift. `PowerSocketAdapter` is the server-side
 * counterpart and pulling the client's reconnect machinery into a server bundle
 * to borrow eight lines is not a trade worth making.
 *
 * @module utils/frameSize
 */

/**
 * Length of one frame in bytes, across every shape these helpers receive.
 *
 * **A string is counted in UTF-16 code units, not UTF-8 bytes.** That is a real
 * approximation and it is deliberate: the alternative is a `TextEncoder` per
 * frame on the hot path to get an exact figure for the payload shape this limit
 * is least useful on. `Buffer.byteLength` and `Blob.size` are exact, so binary
 * frames — the ones a limit exists for — are not approximated. If you need an
 * exact figure for text frames, size them at the peer that produces them.
 *
 * @param {any} data - The frame, in whatever shape arrived.
 * @returns {number} Bytes, or `0` when the shape carries no readable length.
 */
export function frameByteLength(data) {
  if (data == null) return 0;
  if (typeof data.byteLength === 'number') return data.byteLength;
  if (typeof data.size === 'number') return data.size;
  if (typeof data.length === 'number') return data.length;
  return 0;
}
