/**
 * The reply half of a protocol-level heartbeat, shared by `PowerWebSocketClient` and
 * `PowerSocketAdapter`.
 *
 * **RT-016.** These two classes grew independent heartbeat implementations, and the row
 * that asked for them to be unified described them as one-correct and one-broken. That
 * was stale twice over: `RT-003` fixed the client, and after the adapter's four-line
 * `_handlePong` was brought up to the same behaviour the two had *converged* — same
 * deadline-only clear, same timestamp bookkeeping, same guard. At that point the honest
 * description was not "one is broken" but "there are two copies", and a shared function
 * is the whole of the fix.
 *
 * **Why the deadline clear and the measurement are one function.** They are not two
 * steps. The clear settles *one outstanding probe*, and the measurement is the RTT of
 * *that same probe* — reading the timestamp is meaningless if the deadline that would
 * have fired on it is still armed, and clearing it is meaningless if the reading is
 * dropped. Splitting them is how the two classes came to disagree.
 *
 * **Why `clearDeadline` is a callback and not a handle.** The helper does not own the
 * timer, so it cannot null the field that holds it; passing the handle would mean the
 * caller cleared afterwards and the "one outstanding probe" rule would live in two
 * places again. The callback keeps the clear and the read in the same expression.
 *
 * The guards are the client's, verbatim, and each earned its place:
 *
 * - **`if (!sentAt) return`** — a pong arriving with no probe outstanding (a late reply
 *   to a probe already settled) is not a measurement of anything.
 * - **`if (!(rtt >= 0)) return`** — a clock that went backwards is not a measurement.
 *   Written as a negated comparison rather than `rtt < 0` because `NaN` also fails it,
 *   and a `NaN` sample silently poisons a percentile series.
 *
 * @module
 */

/**
 * Settle one outstanding heartbeat probe: clear its deadline, and record the RTT if a
 * probe was actually outstanding.
 *
 * @param {object} probe
 * @param {number} probe.pingSentAt - When the probe was sent; `0` for none.
 * @param {number} probe.now - The current reading, from the same clock that sent it.
 * @param {() => void} probe.clearDeadline - Clear the outstanding probe's timer and
 *   forget its handle. Called **before** the measurement is taken, and whether or not a
 *   probe was outstanding.
 * @param {() => void} [probe.onHeartbeat] - Called once, only when a sample is recorded.
 * @param {(rtt: number) => void} [probe.record] - Receives the RTT. Called only when a
 *   sample is recorded.
 * @returns {number|null} The measured RTT, or `null` when no sample was taken — which is
 *   the answer for a stray pong, a backwards clock, and an outstanding count of zero.
 */
export function settleHeartbeatProbe({ pingSentAt, now, clearDeadline, onHeartbeat, record }) {
  clearDeadline();
  const sentAt = pingSentAt;
  if (!sentAt) return null;
  const rtt = now - sentAt;
  // A clock that went backwards is not a measurement, and `NaN` — which also fails this
  // comparison — would silently poison a percentile series rather than being dropped.
  if (!(rtt >= 0)) return null;
  onHeartbeat?.();
  record?.(rtt);
  return rtt;
}
