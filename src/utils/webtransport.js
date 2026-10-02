/**
 * WT-001 — feature detection for `WebTransport`.
 *
 * **Pure.** No connection is opened, no constructor is called, and nothing is
 * mutated. That is the whole design constraint, and it is why this cannot
 * report every field from the global alone: several of the surfaces below are
 * *instance* attributes of a live `WebTransport`, so asking "does this build
 * support them" without a transport means answering `false` for them, and
 * saying so is better than opening a socket to find out.
 *
 * ## Three of these are not Baseline, and nothing may gate on them
 *
 * | field          | availability                                          |
 * | -------------- | ---------------------------------------------------- |
 * | `reliability`  | **Limited** — not Baseline                            |
 * | `stats`        | **Limited** — `getStats()` is not Baseline           |
 * | `sendGroups`   | **Experimental** — `WebTransportSendGroup`            |
 * | `datagrams`    | Baseline                                             |
 * | `createWritable` | Baseline (with a caveat, below)                    |
 * | `byob`         | Baseline                                             |
 *
 * A detector that reported the optimistic answer for the first three would be
 * the more dangerous kind of wrong: a caller would branch on a surface that is
 * not there, get `undefined`, and discover it as a `TypeError` somewhere else.
 * So **each defaults to `false` on absence and never to `true`**, and
 * `reliableOnly` is `false` whenever any non-Baseline surface is in play — which
 * is the flag a caller should branch on if it wants a promise rather than a
 * fact.
 *
 * ## `createWritable` and the deprecated spelling
 *
 * The writable side of the datagram stream is `transport.datagrams.writable`,
 * which is **deprecated and non-standard** per MDN, and most examples in
 * circulation still use it. So this reports it as *present* — a browser that has
 * only the deprecated spelling genuinely can create the stream — and says in the
 * doc that the spelling is not something to build on. Detecting its absence is
 * still useful: a build without it cannot write datagrams at all.
 */

/**
 * A snapshot of what a build supports for `WebTransport`.
 *
 * @typedef {Object} WebTransportSupport
 * @property {boolean} available - A `WebTransport` constructor exists at all.
 *   Everything else is meaningless when this is `false`.
 * @property {boolean} reliableOnly - **Every** surface reported here is
 *   Baseline, so gating a code path on this object is safe on any engine the
 *   project supports. `false` whenever `stats` or `sendGroups` is present,
 *   because both are non-Baseline — which is the intended use: this is `true`
 *   only for the conservative subset.
 * @property {boolean} datagrams - A datagram duplex stream is available on the
 *   inspected transport. `false` without one (see the note on passing one).
 * @property {boolean} createWritable - The datagram stream is writable.
 *   Detected from `transport.datagrams.writable`, which is **deprecated and
 *   non-standard**; treat presence as "datagrams can be written", not as a
 *   spelling to depend on.
 * @property {boolean} sendGroups - `WebTransportSendGroup` exists.
 *   **Experimental** — defaults to `false`, and `reliableOnly` is `false` while
 *   it is present.
 * @property {boolean} stats - `getStats()` is available on the transport.
 *   **Limited availability** — defaults to `false`, and `reliableOnly` is
 *   `false` while it is present.
 * @property {boolean} byob - BYOB datagram reads are available: the incoming
 *   high-water mark is reported, which is what distinguishes a BYOB-capable
 *   build from one that only queues whole datagrams.
 */

/**
 * Report what the current build supports for `WebTransport`.
 *
 * **Pass a transport to learn about its instance surfaces.** Without one, the
 * instance-level fields — `datagrams`, `createWritable`, `stats`, `byob` — are
 * `false`, because the alternative is constructing a `WebTransport`, which opens
 * a connection. That is the deliberate trade: a probe that cannot be wrong
 * about a socket it never opened.
 *
 * ```javascript
 * const support = detectWebTransportSupport();
 * if (support.reliableOnly) {
 *   // Baseline only: safe to depend on.
 * }
 * ```
 *
 * @param {object} [probe] - What to inspect. Defaults to `globalThis`.
 * @param {Function} [probe.WebTransport] - The constructor to probe.
 * @param {Function} [probe.WebTransportSendGroup] - The experimental group
 *   constructor, passed rather than read from the global so the function stays
 *   pure and testable.
 * @param {object} [probe.transport] - A live transport, used **read-only** for
 *   its `datagrams` and `getStats`. Nothing on it is called except `getStats`,
 *   and only to prove it works, not for its value.
 * @param {object} [probe.transport.datagrams]
 * @param {unknown} [probe.transport.datagrams.writable] - Deprecated and
 *   non-standard; presence only.
 * @param {unknown} [probe.transport.datagrams.readable]
 * @param {number} [probe.transport.incomingHighWaterMark]
 * @param {() => unknown} [probe.transport.getStats]
 * @returns {WebTransportSupport}
 * @since 2.0.0
 */
export function detectWebTransportSupport(probe = {}) {
  const scope = probe ?? {};
  // One widened global, read once. `globalThis` has no index signature, so
  // reading a not-yet-standard name off it is a type error three times over —
  // and the typecheck ratchet exists to stop that being answered by raising a
  // ceiling.
  const globals = /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : undefined);
  const Ctor = scope.WebTransport ?? globals?.WebTransport;
  // `available` first, and everything else is conditioned on it. A build with no
  // constructor cannot have a transport, so the instance fields are `false`
  // rather than "unknown" — the shape does not grow an `unknown`.
  const available = typeof Ctor === 'function';
  if (!available) {
    return Object.freeze({
      available: false,
      reliableOnly: false,
      datagrams: false,
      createWritable: false,
      sendGroups: false,
      stats: false,
      byob: false,
    });
  }

  const sendGroupsCtor = scope.WebTransportSendGroup ?? globals?.WebTransportSendGroup;
  // Experimental, and defaulted to `false` rather than to the constructor's
  // existence, because a partial implementation is worse than none: the caller
  // branches, and the branch reaches a surface that throws.
  const sendGroups = typeof sendGroupsCtor === 'function';

  const transport = scope.transport;
  const datagramStream = transport ? transport.datagrams : undefined;
  const datagrams = datagramStream !== undefined && datagramStream !== null;

  // Deprecated spelling, deliberately. Its absence means datagrams cannot be
  // written at all; its presence is reported without endorsement.
  const createWritable = datagrams && datagramStream.writable !== undefined;

  // `getStats` is checked as a *property* and called only to prove it works,
  // because Limited availability means a build can expose the name and throw
  // from it. **Presence and usability are tracked separately**, and that
  // distinction is load-bearing: `stats` says whether a caller can rely on the
  // call, while `statsPresent` says the surface exists in this build at all, and
  // `reliableOnly` is computed from the latter. A `getStats` that throws is still
  // a non-Baseline surface, and a build carrying one is not a build to gate on —
  // reporting `reliableOnly: true` there would invite exactly the branch the row
  // warns against.
  let stats = false;
  let statsPresent = false;
  if (transport && typeof transport.getStats === 'function') {
    statsPresent = true;
    try {
      const result = transport.getStats();
      stats = result !== undefined && result !== null;
    } catch {
      stats = false;
    }
  }

  // BYOB is a capability rather than a constructor: there is no
  // `WebTransportByob` to test for. `incomingHighWaterMark` is the option that
  // applies to BYOC reads, so a transport reporting it *and* exposing a readable
  // datagram stream is the signal. Note this reads the **transport**, not
  // `datagrams` — the first version of this looked for the mark on the stream,
  // where it does not live, and so reported `byob` only when a transport did not
  // have it.
  const byob =
    transport !== undefined &&
    datagrams &&
    transport.incomingHighWaterMark !== undefined &&
    datagramStream.readable !== undefined;

  return Object.freeze({
    available: true,
    // **The conservative flag, computed from presence rather than usability.**
    // Two of the surfaces below are not Baseline, so a build that carries
    // either — working or throwing — is not one a caller should gate on. It is
    // computed from the fields above rather than from a table, so adding a field
    // cannot leave it stale.
    reliableOnly: !sendGroups && !statsPresent,
    datagrams,
    createWritable,
    sendGroups,
    stats,
    byob,
  });
}
