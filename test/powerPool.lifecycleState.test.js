import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * POOL-007 — `getStats()` described a controller that could never tick, and said
 * nothing at all about whether the idle reaper was alive.
 *
 * **Both reproduced on a real pool before the fix**, with `observability: true`
 * (the `performance` block is conditional, and without it there is nothing to
 * read — an earlier draft of this file hit exactly that and reported
 * `undefined` for `autoScale`, which is why the option is set in the factory
 * below rather than inline).
 *
 * The shape of the defect is that `_clearLifecycleIntervals()` nulls
 * `_autoScaleInterval` and `_reaperInterval` but **leaves `_autoScale` in
 * place**, which is correct — the policy and its bounds are still the pool's
 * configuration, and `recreateWorkers: true` starts the controller again from
 * them. So the config object was the wrong thing to report *as live state*.
 */

/**
 * A pool over a stub worker, so nothing here depends on a real thread.
 * `powerPool.test.js` and `powerPool.protocol.test.js` use the same shape.
 */
class MockUnderlying {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.postMessage = (msg) => {
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: msg });
      }, 0);
    };
    this.terminate = () => {};
  }

  addEventListener(type, cb) {
    if (type === 'message') this.onmessage = cb;
    if (type === 'error') this.onerror = cb;
    if (type === 'messageerror') this.onmessageerror = cb;
  }

  removeEventListener() {}
}

/** A pool with observability on, since `performance` is conditional. */
function pool(options = {}) {
  return new PowerPool(MockUnderlying, {
    size: 1,
    idleTimeout: 1000,
    observability: true,
    ...options,
  });
}

/** The `performance` block of `getStats()`. */
const perf = (p) => p.getStats().performance;

describe('POOL-007: autoScalePolicy reports the live controller, not the stored config', () => {
  it('reports null after the interval is cleared and cannot come back', () => {
    // **The defect.** Before the fix this read `"aimd"` with
    // `_autoScaleInterval` null — a controller that can never tick again,
    // reported as though adaptation were running.
    const p = pool({ autoScale: { policy: 'aimd', intervalMs: 50 } });
    expect(perf(p).autoScalePolicy, 'live: the interval is ticking').toBe('aimd');

    p.stopThePress('stop', undefined, { recreateWorkers: false });

    expect(p._autoScaleInterval, 'and the interval really is gone').toBeNull();
    expect(perf(p).autoScalePolicy, 'so the field must not claim a policy').toBeNull();
    p.shutdown();
  });

  it('keeps reporting the policy when recreateWorkers restarts the controller', () => {
    // **The branch that decides whether the gate is safe.** `_autoScale` is
    // deliberately not cleared, so a pool stopped and recreated *does* get a
    // working controller again. If the fix had gated on `_autoScale` instead of
    // the interval, this would report `null` for a controller that is running —
    // trading one wrong answer for the opposite one.
    const p = pool({ autoScale: { policy: 'aimd', intervalMs: 50 } });
    p.stopThePress('stop', undefined, { recreateWorkers: true });

    expect(p._autoScaleInterval, 'the controller is ticking again').not.toBeNull();
    expect(perf(p).autoScalePolicy).toBe('aimd');
    p.shutdown();
  });

  it('reports null when autoScale was never configured at all', () => {
    // The pre-existing behaviour, kept so the gate is not read as "autoScale is
    // broken when off".
    const p = pool({});
    expect(p._autoScale).toBeNull();
    expect(perf(p).autoScalePolicy).toBeNull();
    p.shutdown();
  });

  it('reports the policy for each policy name, not just the one that was tested', () => {
    // `aimd` is the only policy the defect was demonstrated with. A gate written
    // against a literal would pass that one and lie about the rest.
    for (const name of ['vegas', 'gradient2', 'ewma']) {
      const p = pool({ autoScale: { policy: name, intervalMs: 50 } });
      expect(perf(p).autoScalePolicy, `${name} while live`).toBe(name);
      p.stopThePress('stop', undefined, { recreateWorkers: false });
      expect(perf(p).autoScalePolicy, `${name} once stopped`).toBeNull();
      p.shutdown();
    }
  });

  it('reports null after shutdown, which is final', () => {
    const p = pool({ autoScale: { policy: 'vegas', intervalMs: 50 } });
    p.shutdown();

    expect(p._autoScaleInterval).toBeNull();
    expect(perf(p).autoScalePolicy).toBeNull();
  });

  it('leaves concurrencyLimit alone, because a stopped controller retains its number', () => {
    // **The asymmetry, stated as a test so it cannot be tidied away.** `concurrencyLimit`
    // reports `_adaptiveLimit`, which keeps its value when the controller stops,
    // so it stays true and is deliberately not gated. Only `autoScalePolicy` was
    // making a claim about the present.
    const p = pool({ autoScale: { policy: 'aimd', intervalMs: 50 } });
    const before = perf(p).concurrencyLimit;
    p.stopThePress('stop', undefined, { recreateWorkers: false });

    expect(perf(p).autoScalePolicy).toBeNull();
    expect(perf(p).concurrencyLimit, 'a retained number, not a live claim').toBe(before);
    p.shutdown();
  });
});

describe('POOL-007: whether the idle reaper is running is observable', () => {
  it('exposes the reaper, which had no field at all', () => {
    // **The second half of the row.** There was nothing in `getStats()` to read,
    // so a pool could accumulate idle workers past `idleTimeout` for the rest of
    // its life with no signal that the reaper had stopped. This asserts the field
    // exists as a boolean, which is the minimum a caller can branch on.
    const p = pool({});
    const value = perf(p).idleReapingActive;
    expect(typeof value, 'exposed as a boolean').toBe('boolean');
    expect(value, 'a configured pool reaps').toBe(true);
    p.shutdown();
  });

  it('reports false once the reaper is cleared and cannot come back', () => {
    const p = pool({});
    expect(perf(p).idleReapingActive).toBe(true);

    p.stopThePress('stop', undefined, { recreateWorkers: false });

    expect(p._reaperInterval, 'and the interval really is gone').toBeNull();
    expect(perf(p).idleReapingActive, 'so idle workers now accumulate unchecked').toBe(false);
    p.shutdown();
  });

  it('reports true again when recreateWorkers restores it', () => {
    const p = pool({});
    p.stopThePress('stop', undefined, { recreateWorkers: true });
    expect(perf(p).idleReapingActive).toBe(true);
    p.shutdown();
  });

  it('reports false after shutdown', () => {
    const p = pool({});
    p.shutdown();
    expect(perf(p).idleReapingActive).toBe(false);
  });

  it('is a boolean, never null', () => {
    // **Written because the source comment claimed otherwise.** A first draft of
    // the `idleReapingActive` docblock described a tri-state — `null` for "idle
    // reaping was never configured" against `false` for "configured and stopped".
    // The implementation returns a plain boolean and cannot return `null`: the
    // reaper is created unconditionally in the constructor, so there is no pool
    // without one, only pools whose reaper is stopped.
    //
    // This is worth a test rather than a comment edit alone, because a comment
    // describing a state the value never takes is exactly the kind of
    // documentation that survives into a released type. Asserting the type at
    // every state also means a future change that *does* introduce `null` — to
    // distinguish "never configured" — fails here instead of quietly breaking a
    // reader's `=== null` branch.
    const p = pool({});
    for (const value of [
      perf(p).idleReapingActive,
      (p.stopThePress('stop', undefined, { recreateWorkers: false }), perf(p).idleReapingActive),
      (p.stopThePress('stop', undefined, { recreateWorkers: true }), perf(p).idleReapingActive),
      (p.shutdown(), perf(p).idleReapingActive),
    ]) {
      expect(typeof value, 'boolean in every lifecycle state, never null').toBe('boolean');
    }
  });

  it('is independent of autoScale, so neither field infers the other', () => {
    // Two independent intervals. A reader who has learned that
    // `autoScalePolicy: null` means stopped would otherwise assume the reaper
    // stopped too — and with `autoScale` off there is no policy field to read at
    // all, leaving nothing to notice a stopped reaper by.
    const noAutoScale = pool({});
    expect(perf(noAutoScale).autoScalePolicy).toBeNull();
    expect(perf(noAutoScale).idleReapingActive, 'reaping regardless of autoScale').toBe(true);
    noAutoScale.shutdown();
  });
});
