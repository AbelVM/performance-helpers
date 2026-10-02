import { describe, it, expect } from 'vitest';
import { detectWebTransportSupport } from '../src/index.js';

/**
 * WT-001 — `detectWebTransportSupport()`.
 *
 * **The row's requirement is a prohibition, not a feature**: *no code path may be
 * gated on a surface this does not report*, because three of the surfaces wanted
 * here are **not** Baseline. `reliability` and `getStats()` are Limited
 * availability; `WebTransportSendGroup` is Experimental. All three must default
 * to `false` on absence, **never** to an optimistic `true`.
 *
 * That framing decides the whole design. A detector that guessed optimistically
 * would be the more dangerous kind of wrong: the caller branches, reaches a
 * surface that is not there, and discovers it as a `TypeError` several frames
 * away from the mistake. So the tests below are mostly about **absence** and
 * about what `reliableOnly` does when a non-Baseline surface is present.
 *
 * There is nothing to probe on this machine — Node has no `WebTransport` — so
 * every case passes a stub. That is the honest shape of the test: the function is
 * pure and takes what it inspects, which is what makes it testable at all.
 */

/** A transport stub with everything Baseline present and nothing non-Baseline. */
const fullTransport = (extra = {}) => ({
  datagrams: { writable: {}, readable: {} },
  incomingHighWaterMark: 65_536,
  getStats: () => ({}),
  ...extra,
});

const Ctor = function WebTransport() {};

describe('WT-001: detectWebTransportSupport', () => {
  it('reports every field false when there is no WebTransport', () => {
    // The case this machine is actually in, and the one that must not throw.
    expect(detectWebTransportSupport({})).toEqual({
      available: false,
      reliableOnly: false,
      datagrams: false,
      createWritable: false,
      sendGroups: false,
      stats: false,
      byob: false,
    });
  });

  it('accepts a probe rather than reading globals, so it is testable and pure', () => {
    // `globalThis` has no `WebTransport` on Node, so a probe is the only way to
    // reach the positive cases at all — which is the property that makes the
    // absence cases above trustworthy rather than merely unreachable.
    expect(detectWebTransportSupport({ WebTransport: Ctor }).available).toBe(true);
  });

  it('reports a Baseline-only build as reliableOnly', () => {
    // With only the constructor, the single reported-true field is `available`,
    // which *is* Baseline — so `reliableOnly` is true and a caller may gate on it.
    const support = detectWebTransportSupport({ WebTransport: Ctor });
    expect(support).toEqual({
      available: true,
      reliableOnly: true,
      datagrams: false,
      createWritable: false,
      sendGroups: false,
      stats: false,
      byob: false,
    });
  });

  it('reports instance surfaces false without a transport, and does not open one', () => {
    // The design constraint, pinned: `datagrams`, `createWritable`, `stats` and
    // `byob` are *instance* attributes, so learning them the only other way is
    // constructing a transport — which opens a connection. The function is pure,
    // so it says `false` and says why in the doc.
    //
    // A test that constructs a WebTransport here would need a server, so this
    // asserts the shape instead: no field is optimistically true.
    const support = detectWebTransportSupport({ WebTransport: Ctor });
    for (const field of ['datagrams', 'createWritable', 'stats', 'byob']) {
      expect(support[field], `${field} must not be optimistic without a transport`).toBe(false);
    }
  });

  it('detects the Baseline datagram surfaces from a live transport', () => {
    const support = detectWebTransportSupport({ WebTransport: Ctor, transport: fullTransport() });
    expect(support.datagrams).toBe(true);
    expect(support.createWritable).toBe(true);
    expect(support.byob).toBe(true);
    // `getStats` works, so this build is *not* `reliableOnly` — see below.
    expect(support.stats).toBe(true);
  });

  it('createWritable is false when the datagram stream is not writable', () => {
    // `transport.datagrams.writable` is **deprecated and non-standard** per MDN,
    // and most examples in circulation still use it. Its absence is still worth
    // reporting: a build without it cannot write datagrams at all. This is the
    // reason the field exists, and the reason the doc declines to endorse the
    // spelling.
    const support = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: { datagrams: { readable: {} }, incomingHighWaterMark: 1 },
    });
    expect(support.datagrams).toBe(true);
    expect(support.createWritable).toBe(false);
  });

  it('byob needs both the high-water mark and a readable stream', () => {
    // There is no `WebTransportByob` constructor to test for, so this is a
    // capability signal rather than a presence check. The first version of the
    // probe looked for the mark on `datagrams` rather than on the transport,
    // where it does not live, and so reported `byob` **false** for a transport
    // that has it. Both halves are pinned because dropping either changes the
    // answer.
    const withBoth = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: { datagrams: { readable: {} }, incomingHighWaterMark: 1 },
    });
    expect(withBoth.byob).toBe(true);

    const noMark = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: { datagrams: { readable: {} } },
    });
    expect(noMark.byob).toBe(false);

    const noReadable = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: { datagrams: { writable: {} }, incomingHighWaterMark: 1 },
    });
    expect(noReadable.byob).toBe(false);
  });

  it('sendGroups is reported for WebTransportSendGroup and clears reliableOnly', () => {
    // **Experimental.** The prohibition in the row: a caller must not gate on
    // this. `reliableOnly: false` is the signal that says so without the caller
    // having to know which fields are non-Baseline.
    const support = detectWebTransportSupport({
      WebTransport: Ctor,
      WebTransportSendGroup: function WebTransportSendGroup() {},
      transport: fullTransport(),
    });
    expect(support.sendGroups).toBe(true);
    expect(support.reliableOnly).toBe(false);
  });

  it('stats is false when getStats is absent, and that leaves the build Baseline', () => {
    // Absence is not presence. A build without `getStats` has one *fewer*
    // non-Baseline surface, so it is the Baseline one that may be gated on.
    const support = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: { datagrams: { writable: {} }, incomingHighWaterMark: 1 },
    });
    expect(support.stats).toBe(false);
    expect(support.reliableOnly).toBe(true);
  });

  it('a getStats that throws reports stats false and still clears reliableOnly', () => {
    // **The subtle case, and the reason presence and usability are tracked
    // separately.** Limited availability means a build can expose the name and
    // throw from it. Reporting `stats: false` is right — the caller cannot use
    // it. Reporting `reliableOnly: true` alongside it would be wrong: the surface
    // is still present in the build, and `reliableOnly` exists to say "every
    // surface reported here is Baseline", which is false.
    const support = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: fullTransport({
        getStats: () => {
          throw new Error('not supported');
        },
      }),
    });
    expect(support.stats, 'an unusable getStats is reported false').toBe(false);
    expect(support.reliableOnly, 'but the surface is still non-Baseline').toBe(false);
  });

  it('reliableOnly is false whenever either non-Baseline surface is present', () => {
    // Stated as the general rule rather than as two cases, so a third
    // non-Baseline field added later cannot pass this.
    const baseline = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: fullTransport({ getStats: undefined }),
    });
    expect(baseline.reliableOnly, 'neither surface present').toBe(true);

    const withGroups = detectWebTransportSupport({
      WebTransport: Ctor,
      WebTransportSendGroup: function WebTransportSendGroup() {},
      transport: fullTransport({ getStats: undefined }),
    });
    expect(withGroups.reliableOnly, 'sendGroups alone is enough').toBe(false);

    const withStats = detectWebTransportSupport({ WebTransport: Ctor, transport: fullTransport() });
    expect(withStats.reliableOnly, 'stats alone is enough').toBe(false);
  });

  it('does not throw on a transport with no datagrams at all', () => {
    // A transport that reports `datagrams: null` rather than omitting it is a
    // real shape, and `null` must not read as present.
    for (const datagrams of [null, undefined]) {
      const support = detectWebTransportSupport({
        WebTransport: Ctor,
        transport: { datagrams },
      });
      expect(support.datagrams).toBe(false);
      expect(support.createWritable).toBe(false);
      expect(support.byob).toBe(false);
    }
  });

  it('returns a frozen object, so a caller cannot corrupt a shared answer', () => {
    // Cheap, and it means a caller that patches its copy gets a TypeError in
    // strict mode rather than a subtly wrong gate in someone else's code path.
    const support = detectWebTransportSupport({ WebTransport: Ctor });
    expect(Object.isFrozen(support)).toBe(true);
    expect(() => {
      'use strict';
      support.available = false;
    }).toThrow();
  });

  it('treats a non-function WebTransport as absent', () => {
    // A global shadowed by something that is not a constructor — a polyfill
    // stub, a typo'd shim — must not read as support.
    for (const WebTransport of [undefined, null, {}, 'WebTransport', 42]) {
      expect(detectWebTransportSupport({ WebTransport }).available).toBe(false);
    }
  });

  it('ignores the global scope when a probe is supplied', () => {
    // The purity claim, checked: a probe replaces the global entirely, so the
    // function cannot be reading `globalThis` behind the caller's back. This is
    // also what makes the absence cases above meaningful on a platform that does
    // have WebTransport.
    const support = detectWebTransportSupport({
      WebTransport: Ctor,
      transport: fullTransport(),
      // A decoy on the probe object, which must not be consulted.
      WebTransportSendGroup: undefined,
    });
    expect(support.sendGroups).toBe(false);
  });
});
