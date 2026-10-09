/**
 * PowerHeartbeat
 *
 * Liveness detector for a peer that is expected to check in on a schedule.
 * The helper owns the timer: it schedules a check at `interval` (plus jitter)
 * and declares the peer dead when no `beat()` has arrived within `timeout`.
 *
 * The jitter is the reason this exists rather than a bare `setInterval`. A
 * fleet of peers that all start from the same clock fires in lockstep, so the
 * timeout checks - and any reconnect storm that follows a shared failure -
 * arrive as one spike instead of a spread. Jittering the *scheduled* interval
 * by a fraction of itself decorrelates them without changing the mean rate.
 *
 * @class PowerHeartbeat
 * @public
 */
export class PowerHeartbeat {
    /**
     * @typedef {import('./jsdoc-types.js').PowerHeartbeatOptions} PowerHeartbeatOptions
     */
    /**
     * @param {number | PowerHeartbeatOptions} [options]
     */
    constructor(options?: number | import("./jsdoc-types.js").PowerHeartbeatOptions);
    /** @type {ReturnType<typeof setTimeout> | null} */
    /**
     * Begin scheduling liveness checks. Idempotent: a second `start()` on a
     * running heartbeat does not reset the schedule, because the caller that
     * re-enters `start()` after a reconnect would otherwise silently postpone
     * the deadline it is trying to enforce.
     * @returns {void}
     */
    start(): void;
    /**
     * Stop scheduling checks. The recorded state (`missedBeats`, `lastBeatAt`)
     * survives, so a `stop()`/`start()` pair resumes the same deadline rather
     * than granting the peer a fresh one.
     * @returns {void}
     */
    stop(): void;
    /**
     * Record that the peer is alive. Resets the missed-beat counter and the
     * deadline, and fires `onBeat` when one was configured.
     * @returns {void}
     */
    beat(): void;
    /**
     * Register the timeout callback after construction.
     *
     * Exists because the option form is awkward for the common case: the
     * heartbeat is usually built before the object that knows how to react to a
     * dead peer, and threading a closure through the constructor inverts that
     * dependency.
     * @param {(missedBeats: number, lastBeatAt: number) => void} cb
     * @returns {void}
     */
    onTimeout(cb: (missedBeats: number, lastBeatAt: number) => void): void;
    /**
     * @returns {boolean} Whether checks are currently scheduled.
     */
    isRunning(): boolean;
    /**
     * @returns {number} Consecutive checks that found no `beat()`.
     */
    get missedBeats(): number;
    /**
     * @returns {number} Timestamp of the last `beat()`, or `0` if there was none.
     */
    get lastBeatAt(): number;
    /**
     * @returns {boolean} Whether the peer has been declared dead and has not
     *   since called `beat()`.
     */
    get timedOut(): boolean;
    /**
     * The next delay, jittered.
     *
     * Jitter is applied to the *scheduled* interval rather than to the deadline,
     * so a peer that beats on time is never failed for arriving early: the
     * deadline is `timeout` after the last beat, and only the polling cadence
     * moves.
     * @returns {number}
     */
    _nextDelay(): number;
    _schedule(): void;
    _check(): void;
    _clearTimer(): void;
    /**
     * Release the timer.
     *
     * This helper **owns a timer**, so `dispose()` clears it - it is not a state
     * reset. The distinction matters for `using` / `await using`: a heartbeat
     * left scheduled after its owner is gone keeps the event loop alive and
     * keeps firing a callback into a torn-down object.
     * @returns {void}
     */
    dispose(): void;
    [Symbol.dispose](): void;
    [Symbol.asyncDispose](): Promise<void>;
}
export default PowerHeartbeat;
