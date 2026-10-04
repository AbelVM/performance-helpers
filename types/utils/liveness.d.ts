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
 * Send one heartbeat probe, and arm its deadline if one was sent.
 *
 * **The one behaviour that was not already shared, and the reason this function exists
 * rather than a merge.** The two classes disagreed on what a throwing `ping()` means:
 * `PowerSocketAdapter` reported it and returned, so no deadline was armed;
 * `PowerWebSocketClient` reported it and fell through, so a deadline was armed against a
 * probe that had never gone out. A deadline that fires with nothing outstanding reports a
 * transport dead that may not be — so **arming on a failed send is the worse of the two**,
 * and that is the behaviour both classes now have.
 *
 * The reasoning, so the decision is arguable rather than merely asserted: a failed `ping()`
 * means the transport is already broken, and the honest report is the error, not a timeout
 * against a probe nobody will answer. A liveness signal that fires spuriously is worse
 * than one that fires late, because it closes a healthy connection.
 *
 * The deadline is also armed **once per live window** — never while one is outstanding.
 * Two bugs live in that condition, both measured on a socket whose `ping()` is never
 * answered: re-arming without clearing orphaned one timer per tick (three ticks, three
 * deadlines, zero cleared), and *clearing and re-arming* means a socket that never answers
 * never times out at all whenever `heartbeatTimeoutMs` exceeds `heartbeatIntervalMs`,
 * because the deadline would keep measuring from the latest ping rather than the first.
 *
 * @param {object} probe
 * @param {boolean} probe.canPing - Whether the transport exposes a usable `ping()`. When
 *   `false` nothing is sent, nothing is armed, and `false` is returned: a browser does not
 *   expose `ping()` by design, and inventing a probe there would be a lie.
 * @param {() => void} probe.ping - Sends the probe. May throw.
 * @param {(err: unknown) => void} [probe.onPingError] - Receives a throw from `ping()`.
 *   The error is reported and **no deadline is armed**.
 * @param {number} probe.now - The clock reading to record as the send time.
 * @param {(now: number) => void} [probe.markSent] - Records the send time, before the
 *   ping goes out, so a synchronous reply still finds it.
 * @param {number} probe.timeoutMs - `0` disables the deadline entirely.
 * @param {() => boolean} [probe.hasOutstanding] - Whether a deadline is already armed.
 * @param {() => void} [probe.arm] - Arms the deadline. Only reached when a probe was sent.
 * @returns {boolean} `true` when a probe was sent, `false` otherwise — including when
 *   `ping()` threw, which is why callers cannot infer "armed" from the return.
 */
export function sendHeartbeatProbe({ canPing, ping, onPingError, now, markSent, timeoutMs, hasOutstanding, arm, }: {
    canPing: boolean;
    ping: () => void;
    onPingError?: ((err: unknown) => void) | undefined;
    now: number;
    markSent?: ((now: number) => void) | undefined;
    timeoutMs: number;
    hasOutstanding?: (() => boolean) | undefined;
    arm?: (() => void) | undefined;
}): boolean;
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
export function settleHeartbeatProbe({ pingSentAt, now, clearDeadline, onHeartbeat, record }: {
    pingSentAt: number;
    now: number;
    clearDeadline: () => void;
    onHeartbeat?: (() => void) | undefined;
    record?: ((rtt: number) => void) | undefined;
}): number | null;
