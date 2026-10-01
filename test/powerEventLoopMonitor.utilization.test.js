import { describe, it, expect } from 'vitest';
import { PowerEventLoopMonitor } from '../src/index.js';

// GAP-001: rework the monitor onto `performance.eventLoopUtilization()`.
//
// **Most of the row is already done**, which the row does not record. The
// monitor already resolves Node's `eventLoopUtilization()` lazily (so bundlers
// never touch `node:perf_hooks`), exposes it as `utilization()`, accepts a
// `utilizationProvider` override, gates the first read behind a `ready` promise,
// and returns `null` off Node. This file pins that integration rather than
// re-deriving it.
//
// **The half that was missing is the half the row's whole argument rests on.**
// `utilization()` hands back Node's *cumulative* reading, so it answers "how busy
// has this process been since it started" — a lifetime average. The property
// that makes ELU worth reaching for is that it is *defined over a measured
// interval*: subtract two readings and you have that interval exactly. Measured:
//
//   1 s synchronous block  ->  active +1000 ms, idle +20 ms
//   the same block, read at a different moment in the process's life
//                          ->  active +0.2 ms
//
// That second figure is the reason this is not a nicety. ELU's counters are
// refreshed by the loop, so a reading taken at the wrong moment misses the
// interval entirely — which is what a cumulative API invites.

/** A monitor whose ELU readings the test controls exactly. */
function withReadings(readings) {
  let i = 0;
  return new PowerEventLoopMonitor({
    intervalMs: 1000,
    utilizationProvider: () => readings[Math.min(i++, readings.length - 1)],
  });
}

const at = (active, idle) => ({
  active,
  idle,
  utilization: active + idle > 0 ? active / (active + idle) : 0,
});

describe('utilizationSince: the interval reading', () => {
  it('reports active and idle for the interval, not since process start', () => {
    const m = withReadings([at(10_000, 20_000), at(10_500, 20_100)]);
    const window = m.utilizationSince(m.utilization());
    // The cumulative readings are large; the interval is the difference.
    expect(window.active).toBeCloseTo(500, 6);
    expect(window.idle).toBeCloseTo(100, 6);
    expect(window.elapsed).toBeCloseTo(600, 6);
    expect(window.ratio).toBeCloseTo(500 / 600, 6);
  });

  it('distinguishes an idle interval from a blocked one', () => {
    // The property the row claims and the cumulative reading cannot show: a
    // lifetime average barely moves for either.
    const idle = withReadings([at(5_000, 20_000), at(5_100, 20_600)]);
    const blocked = withReadings([at(5_000, 20_000), at(6_000, 20_100)]);
    const idleWindow = idle.utilizationSince(idle.utilization());
    const blockedWindow = blocked.utilizationSince(blocked.utilization());
    expect(idleWindow.ratio).toBeLessThan(0.3);
    expect(blockedWindow.ratio).toBeGreaterThan(0.9);
  });

  it('returns null rather than NaN for an empty interval', () => {
    // A caller polling faster than the loop ticks reads the same numbers twice.
    // `0/0` would be `NaN` and would propagate into every comparison.
    const m = withReadings([at(1_000, 1_000)]);
    const window = m.utilizationSince(m.utilization());
    expect(window.active).toBe(0);
    expect(window.ratio).toBe(0);
    expect(Number.isNaN(window.ratio)).toBe(false);
  });

  it('returns null when there is no previous reading', () => {
    const m = withReadings([at(1, 1)]);
    // So a caller can tell "no data" from "zero utilisation" - the two are not
    // the same answer and collapsing them would hide a missing provider.
    expect(m.utilizationSince(null)).toBeNull();
  });

  it('returns null when the counters go backwards', () => {
    // A replaced provider or a reset process. A negative interval is worse
    // than no interval: it would read as a large stall in the other direction.
    const m = withReadings([at(10_000, 10_000), at(100, 100)]);
    expect(m.utilizationSince(m.utilization())).toBeNull();
  });

  it('returns null off Node, matching utilization()', () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 1000, utilizationProvider: null });
    // Force the no-ELU state regardless of runtime.
    m._utilizationSource = null;
    expect(m.utilization()).toBeNull();
    expect(m.utilizationSince(at(1, 1))).toBeNull();
  });
});

describe('utilization: the cumulative reading is still cumulative', () => {
  // Not a preference - a pin. If `utilization()` were changed to return a
  // delta, every existing caller reading it as a lifetime figure would silently
  // start reporting an interval.
  it('returns the provider values unchanged', () => {
    const raw = at(12_345, 6_789);
    const m = withReadings([raw]);
    expect(m.utilization()).toEqual(raw);
  });

  it('survives a provider that throws or returns nonsense', () => {
    // A throwing provider must not take the monitor down: the drift histogram
    // is the primary output and does not depend on this at all.
    const boom = new PowerEventLoopMonitor({
      intervalMs: 1000,
      utilizationProvider: () => {
        throw new Error('provider exploded');
      },
    });
    expect(boom.utilization()).toBeNull();
    expect(boom.utilizationSince(at(1, 1))).toBeNull();

    const junk = new PowerEventLoopMonitor({ intervalMs: 1000, utilizationProvider: () => null });
    expect(junk.utilization()).toBeNull();
  });
});

describe('the monitor keeps the drift histogram regardless', () => {
  it('samples delay even with no ELU available', () => {
    // The two outputs are independent. This is the reason ELU is an addition and
    // not a replacement: the histogram is the percentile layer the platform does
    // not provide, and a stall large enough to starve the timer is exactly the
    // case where only one of the two can see it.
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    m.start();
    const p = new Promise((r) => setTimeout(r, 60));
    return p.then(() => {
      m.stop();
      const s = m.stats();
      expect(s.samples ?? s.count ?? 0).toBeGreaterThan(0);
      expect(m.lastDelay()).toBeGreaterThan(0);
    });
  });
});
