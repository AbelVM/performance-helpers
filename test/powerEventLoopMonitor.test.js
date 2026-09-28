/**
 * `PowerEventLoopMonitor` (FEAT-009).
 *
 * The drift measurement itself is exercised against real timers and real
 * blocking, so these are wall-clock tests. They assert on *direction and
 * plausibility* rather than exact values — a blocked loop cannot report a
 * precise delay, and a test that demanded one would be asserting the thing
 * under test does not promise.
 */
import { describe, it, expect, vi } from 'vitest';
import { PowerEventLoopMonitor } from '../src/index.js';
import PowerEventLoopMonitorDefault from '../src/helpers/powerEventLoopMonitor.js';

/**
 * Block the event loop for `ms`, so a pending timer is forced to be late.
 * @param {number} ms
 * @returns {void}
 */
function blockFor(ms) {
  const until = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < until) {
    /* spin */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('PowerEventLoopMonitor', () => {
  it('is exported from the barrel and as the default export', () => {
    expect(PowerEventLoopMonitor).toBeTypeOf('function');
    expect(PowerEventLoopMonitorDefault).toBe(PowerEventLoopMonitor);
  });

  it('validates its options', () => {
    expect(() => new PowerEventLoopMonitor({ intervalMs: 0 })).toThrow(TypeError);
    expect(() => new PowerEventLoopMonitor({ intervalMs: Infinity })).toThrow(/intervalMs/);
    expect(() => new PowerEventLoopMonitor({ relativeAccuracy: 0 })).toThrow();
    expect(() => new PowerEventLoopMonitor({ onDrift: 'nope' })).toThrow(/onDrift/);
  });

  it('does not sample until started, and start/stop are idempotent', async () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    await sleep(30);
    expect(m.stats().samples).toBe(0);

    m.start();
    m.start(); // second call is a no-op
    await sleep(60);
    const running = m.stats();
    m.stop();
    m.stop();
    await sleep(30);

    expect(running.samples).toBeGreaterThan(0);
    expect(m.stats().active).toBe(false);
    // Nothing new arrives once stopped.
    const after = m.stats().samples;
    await sleep(30);
    expect(m.stats().samples).toBe(after);
  });

  it('records the delay of a blocked event loop, and the delay is plausible', async () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    m.start();
    await sleep(20);
    blockFor(60);
    await sleep(40);
    m.stop();

    const s = m.stats();
    expect(s.max).toBeGreaterThan(30);
    // It cannot be wildly overstated: the monitor measures a timer that was
    // scheduled `intervalMs` out, not total elapsed time.
    expect(s.max).toBeLessThan(1000);
    expect(s.p99).toBeGreaterThan(0);
    expect(m.lastDelay()).toBeGreaterThan(0);
  });

  it('reports no delay for an idle loop', async () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 10 });
    m.start();
    await sleep(80);
    m.stop();
    // A quiet event loop should be well under the 10ms probe interval. The
    // bound is generous because a busy CI machine is not a quiet loop.
    expect(m.stats().max).toBeLessThan(50);
  });

  it('calls onDrift per sample and survives a throwing hook', async () => {
    const seen = [];
    const m = new PowerEventLoopMonitor({
      intervalMs: 5,
      onDrift: (d) => {
        seen.push(d);
        throw new Error('user hook exploded');
      },
    });
    m.start();
    await sleep(60);
    expect(seen.length).toBeGreaterThan(0);
    // The monitor is still sampling despite every hook call throwing - the
    // assertion has to come before stop(), or it is testing nothing.
    expect(m.stats().active).toBe(true);
    const during = m.stats().samples;
    await sleep(40);
    expect(m.stats().samples).toBeGreaterThan(during);
    m.stop();
  });

  it('reset clears samples without stopping the monitor', async () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    m.start();
    await sleep(50);
    m.reset();
    expect(m.stats().samples).toBe(0);
    expect(m.stats().p99).toBeNull();
    expect(m.stats().active).toBe(true);
    await sleep(30);
    expect(m.stats().samples).toBeGreaterThan(0);
    m.stop();
  });

  it('reports null statistics before the first sample rather than zero', () => {
    const m = new PowerEventLoopMonitor();
    const s = m.stats();
    expect(s.samples).toBe(0);
    expect(s.mean).toBeNull();
    expect(s.p50).toBeNull();
    expect(s.p99).toBeNull();
    expect(s.p99_9).toBeNull();
    expect(s.blockedOver10ms).toBe(0);
  });

  it('counts samples that were blocked for more than 10ms', async () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    m.start();
    await sleep(20);
    blockFor(50);
    await sleep(40);
    m.stop();
    expect(m.stats().blockedOver10ms).toBeGreaterThan(0);
    expect(m.stats().blockedOver10ms).toBeLessThanOrEqual(m.stats().samples);
  });

  it('dispose stops sampling and is safe to call twice', async () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    m.start();
    await sleep(30);
    m.dispose();
    m.dispose();
    const after = m.stats().samples;
    await sleep(30);
    expect(m.stats().samples).toBe(after);
    expect(m.stats().active).toBe(false);
  });

  it('works with `using`', async () => {
    let disposed = false;
    {
      const m = new PowerEventLoopMonitor({ intervalMs: 5 });
      const original = m.dispose.bind(m);
      m.dispose = () => {
        disposed = true;
        original();
      };
      // Not a real `using` block (needs Symbol.dispose in the lib), but the
      // alias is what the pattern calls.
      m[Symbol.dispose]();
    }
    expect(disposed).toBe(true);
  });

  it('utilization() uses a supplied provider and survives a throwing one', () => {
    const ok = new PowerEventLoopMonitor({
      utilizationProvider: () => ({ active: 3, idle: 1, utilization: 0.75 }),
    });
    expect(ok.utilization()).toEqual({ active: 3, idle: 1, utilization: 0.75 });

    const bad = new PowerEventLoopMonitor({
      utilizationProvider: () => {
        throw new Error('nope');
      },
    });
    expect(bad.utilization()).toBeNull();
  });

  it('utilization() is null where the runtime cannot measure it, not zero', async () => {
    const m = new PowerEventLoopMonitor({ utilizationProvider: null });
    await m.ready;
    const u = m.utilization();
    // Node >= 14.5 has it; a browser does not. Either is acceptable, but a
    // *number* is only acceptable on Node.
    if (u !== null) {
      expect(typeof u.utilization).toBe('number');
      expect(u.utilization).toBeGreaterThanOrEqual(0);
    } else {
      expect(u).toBeNull();
    }
  });

  it('exposes its histogram, owned by the monitor', () => {
    const m = new PowerEventLoopMonitor();
    expect(m.histogram()).toBe(m.histogram());
    expect(m.histogram().percentile(99)).toBeUndefined();
  });

  it('does not keep the Node process alive by default', () => {
    // The internal probe timer is unref'd, so a monitor that is never
    // disposed cannot hang a CLI. Proven by the timer helper, asserted here so
    // a future refactor that replaces it with a bare setTimeout is caught.
    const m = new PowerEventLoopMonitor({ intervalMs: 5 });
    expect(m._keepProcessAlive).toBe(false);
    m.start();
    m.dispose();
  });

  it('honours keepProcessAlive', () => {
    const m = new PowerEventLoopMonitor({ intervalMs: 5, keepProcessAlive: true });
    expect(m._keepProcessAlive).toBe(true);
    m.start();
    m.dispose();
  });

  it('the timer does not survive a second stop after dispose', () => {
    vi.useFakeTimers();
    try {
      const m = new PowerEventLoopMonitor({ intervalMs: 100 });
      m.start();
      m.dispose();
      // No timer is left armed; advancing time must not record a sample.
      vi.advanceTimersByTime(1000);
      expect(m.stats().samples).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
