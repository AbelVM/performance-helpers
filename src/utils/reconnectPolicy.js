/**
 * Decorrelated-jitter backoff, shared by the transports that reconnect.
 *
 * @module utils/reconnectPolicy
 */

/**
 * The backoff curve and jitter for a reconnecting transport.
 *
 * **Why this exists.** `powerWebSocketClient` and `powerWebTransportClient` each
 * carried a private `_nextReconnectDelay()` that was character-for-character
 * identical — the same AWS "Exponential Backoff and Jitter" (2015) curve, the
 * same `* 3` growth, the same `Math.floor`. Two copies of one state machine is
 * two places for the same off-by-one, and neither had a unit test of its own:
 * the curve was only ever exercised through a live transport, so a regression in
 * it would surface as a flaky integration test rather than a red unit.
 *
 * **Scope, deliberately narrow.** This is the *curve* — the part that is purely
 * computational and therefore cleanly testable. It is **not** the attempt cap,
 * the elapsed bound, or the timer lifecycle: those live in each transport
 * because the two differ on purpose. `powerWebSocketClient` records
 * `_reconnectExhaustedBy` and does not count an exhausted attempt;
 * `powerWebTransportClient` counts it and records nothing. Unifying that would
 * be a behaviour change dressed as a refactor, and it is not what this is for.
 *
 * The audit that asked for this described "four copies". There are **two**:
 * `powerRTCChannel` has no reconnect logic at all — a data channel does not
 * reconnect, the `RTCPeerConnection` beneath it does, at a layer this class does
 * not own — and `powerSseAdapter` is server-side, where the browser's
 * `EventSource` performs the reconnection. Recorded here so the next reader does
 * not go looking for the other two.
 *
 * @example
 * const policy = new ReconnectPolicy({ baseMs: 500, maxMs: 30_000 });
 * policy.next(); // a delay in [250, 750]
 * policy.next(); // a delay in [750, 2250]
 * policy.reset(); // back to the base, for a fresh connection
 */
export class ReconnectPolicy {
  /**
   * @param {object} options
   * @param {number} [options.baseMs=500] - The first delay, and the value the
   *   cursor resets to. The curve grows from here.
   * @param {number} [options.maxMs=30000] - Ceiling for both the cursor and the
   *   returned delay.
   * @param {() => number} [options.random=Math.random] - The jitter source.
   *   Injectable so a test can pin the curve rather than assert on a range.
   */
  constructor(options = {}) {
    const baseMs = options.baseMs ?? 500;
    const maxMs = options.maxMs ?? 30_000;
    if (!Number.isFinite(baseMs) || baseMs < 0) {
      throw new TypeError('ReconnectPolicy: baseMs must be a finite number >= 0');
    }
    if (!Number.isFinite(maxMs) || maxMs < 0) {
      throw new TypeError('ReconnectPolicy: maxMs must be a finite number >= 0');
    }
    // The ceiling is applied to the cursor as well as the delay, so a base above
    // the max does not produce a cursor that grows without ever being clamped.
    this._baseMs = Math.min(baseMs, maxMs);
    this._maxMs = maxMs;
    this._random = typeof options.random === 'function' ? options.random : Math.random;
    /**
     * The cursor, in ms. `null` until the first `next()`, which is what makes the
     * first delay exactly `baseMs` rather than a jittered value derived from
     * nothing.
     * @type {number|null}
     */
    this._cursor = null;
  }

  /**
   * The base delay, in ms.
   * @returns {number}
   */
  get baseMs() {
    return this._baseMs;
  }

  /**
   * The ceiling, in ms.
   * @returns {number}
   */
  get maxMs() {
    return this._maxMs;
  }

  /**
   * The current cursor, in ms, or the base before the first `next()`.
   *
   * Exposed for diagnostics and for the transports' own `stats()`. Reading it
   * does not advance the curve.
   * @returns {number}
   */
  get cursorMs() {
    return this._cursor ?? this._baseMs;
  }

  /**
   * The next delay, in ms, advancing the curve.
   *
   * Decorrelated jitter, per AWS "Exponential Backoff and Jitter" (2015): the
   * delay is drawn from `[cursor/2, cursor]` rather than from `[0, cursor]`,
   * which decorrelates far better than full jitter under load. That matters
   * because a server restart otherwise produces a synchronised reconnect
   * stampede from every client at once — full jitter spreads the retries but
   * still lets a cohort re-form, whereas decorrelated jitter does not.
   *
   * The cursor then grows by `* 3` and is clamped, so the *next* draw is from a
   * wider band. Growth is applied after the draw, which is what makes the first
   * delay exactly `baseMs`.
   *
   * @returns {number} An integer number of ms, in `(0, maxMs]`.
   */
  next() {
    if (this._cursor === null) this._cursor = this._baseMs;
    const half = this._cursor / 2;
    const delay = Math.min(this._maxMs, half + this._random() * half);
    this._cursor = Math.min(this._maxMs, this._cursor * 3);
    return Math.floor(delay);
  }

  /**
   * Return the cursor to the base, for a connection that succeeded.
   *
   * **Call this on a successful open, not only on construction.** A transport
   * that reconnects after a long outage would otherwise resume from a cursor
   * grown by the outage's failed attempts, so the first delay after a *good*
   * connection is still seconds long. Resetting on success is what makes the
   * curve track the current conditions rather than the worst it has seen.
   * @returns {void}
   */
  reset() {
    this._cursor = null;
  }
}
