import { describe, it, expect, beforeEach } from 'vitest';
// `defaultMetrics` is internal — the barrel exports the helpers, not the shared
// collector — so a test that has to inspect registrations imports it directly,
// as `test/metrics.test.js` does.
import { defaultMetrics } from '../src/helpers/metrics.js';
import { PowerEventLoopMonitor } from '../src/helpers/powerEventLoopMonitor.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerRetryBudget } from '../src/helpers/powerRetry.js';

/**
 * `OBS-001` and `OBS-002`: metrics registrations outliving the object they
 * describe, or being destroyed too early.
 *
 * Both directions of that mistake are silent. A registration that outlives its
 * object is sampled forever by a collector holding a closure over something
 * nobody can reach, and because `getStats()` still answers, the series looks
 * live — so nothing fails. A registration destroyed too early is the mirror
 * image: the helper is working, reporting nothing, and there is no error to
 * find. `guides/metrics.md` states the guarantee and then lists the helpers that
 * must honour it; two of them did not, and one more did it in the wrong method.
 */
describe('metrics registration lifetime (OBS-001, OBS-002)', () => {
  beforeEach(() => {
    for (const name of ['loop', 'bulkhead', 'retryBudget']) defaultMetrics.unregister(name);
  });

  it('a stop/start cycle keeps the monitor registered', () => {
    // OBS-001, and the method's own JSDoc is what makes it a defect: it
    // advertises "in-flight samples already recorded are kept, so a stop/start
    // cycle does not lose history". It used to `detach` here, and `start()` does
    // not re-attach — so the documented cycle left the monitor sampling and
    // reporting nothing, permanently, and the only way back was a new monitor,
    // which loses the collected history too. An app toggling sampling on a debug
    // flag is the caller this breaks.
    const monitor = new PowerEventLoopMonitor({ intervalMs: 10, observability: true });
    expect(defaultMetrics.names()).toContain('loop');

    monitor.stop();
    expect(defaultMetrics.names()).toContain('loop');

    monitor.start();
    expect(defaultMetrics.names()).toContain('loop');
    // ...and it is still *sampled*, not merely still named. A registration whose
    // reader was swapped out would pass the check above.
    expect(Object.keys(defaultMetrics.snapshot().series).some((k) => k.startsWith('loop.'))).toBe(
      true
    );
    monitor.dispose();
  });

  it('stop() is still idempotent and still returns this', () => {
    const monitor = new PowerEventLoopMonitor({ intervalMs: 10, observability: true });
    expect(monitor.stop()).toBe(monitor);
    expect(monitor.stop()).toBe(monitor);
    expect(monitor.start()).toBe(monitor);
    monitor.dispose();
    monitor.dispose();
  });

  it('dispose() is the only thing that unregisters the monitor', () => {
    // The counterpart, and the reason the fix is a move rather than a deletion:
    // a terminal teardown must still release the registration, or the collector
    // holds a closure over a disposed monitor forever.
    const monitor = new PowerEventLoopMonitor({ intervalMs: 10, observability: true });
    monitor.dispose();
    expect(defaultMetrics.names()).not.toContain('loop');
    // Idempotent, so a double dispose cannot throw on a null receipt.
    expect(() => monitor.dispose()).not.toThrow();
  });

  it('PowerBulkhead.dispose unregisters, and reset alone does not', () => {
    // `dispose` was a bare alias for `reset`, and `reset` is a *reuse* operation
    // — the partition table and counters go back to zero, the object stays
    // usable. Unregistering there would make the series flap on every reset, so
    // the split is deliberate: `reset` keeps the registration, `dispose` ends it.
    const bulkhead = new PowerBulkhead({ partitions: 2, observability: true });
    expect(defaultMetrics.names()).toContain('bulkhead');

    bulkhead.reset();
    expect(defaultMetrics.names()).toContain('bulkhead');

    bulkhead.dispose();
    expect(defaultMetrics.names()).not.toContain('bulkhead');
  });

  it('using PowerBulkhead unregisters, via Symbol.dispose', () => {
    // `Symbol.dispose` called `reset()`, so `using` a bulkhead left it
    // registered. A `using` block is a scope exit — exactly the teardown the
    // guarantee is about — so this is the path a caller is most likely to take.
    const held = { bulkhead: null };
    {
      using bulkhead = new PowerBulkhead({ partitions: 2, observability: true });
      held.bulkhead = bulkhead;
      expect(bulkhead.partitions).toBe(2);
      expect(defaultMetrics.names()).toContain('bulkhead');
    }
    expect(held.bulkhead.partitions).toBe(2);
    expect(defaultMetrics.names()).not.toContain('bulkhead');
  });

  it('PowerRetryBudget has a dispose that unregisters', () => {
    // New method, for the reason `guides/metrics.md` gives: a disposed budget
    // that stays registered is sampled forever and its `stats()` still answers,
    // so nothing fails visibly.
    const budget = new PowerRetryBudget({ ratio: 0.2, observability: true });
    expect(defaultMetrics.names()).toContain('retryBudget');

    budget.dispose();
    expect(defaultMetrics.names()).not.toContain('retryBudget');
    // Idempotent.
    expect(() => budget.dispose()).not.toThrow();
  });

  it('PowerRetryBudget.reset does not unregister, because a budget is reusable', () => {
    const budget = new PowerRetryBudget({ ratio: 0.2, observability: true });
    budget.reset();
    expect(defaultMetrics.names()).toContain('retryBudget');
    expect(budget.stats().retries).toBe(0);
    budget.dispose();
  });

  it('using PowerRetryBudget unregisters, via Symbol.dispose', () => {
    const held = { budget: null };
    {
      using budget = new PowerRetryBudget({ ratio: 0.2, observability: true });
      held.budget = budget;
      expect(budget.available()).toBeGreaterThan(0);
      expect(defaultMetrics.names()).toContain('retryBudget');
    }
    expect(held.budget.available()).toBeGreaterThan(0);
    expect(defaultMetrics.names()).not.toContain('retryBudget');
  });

  it('a helper that never opted in stays unregistered through teardown', () => {
    // The other direction: the fix must not make observability a side effect.
    // A `detach` on a null receipt has to stay a no-op, or every helper without
    // the option would grow a teardown path it does not need.
    const bulkhead = new PowerBulkhead({ partitions: 2 });
    const budget = new PowerRetryBudget({ ratio: 0.2 });
    const monitor = new PowerEventLoopMonitor({ intervalMs: 10 });
    expect(bulkhead._metrics ?? null).toBeNull();
    expect(budget._metrics ?? null).toBeNull();
    expect(monitor._metrics ?? null).toBeNull();
    expect(() => {
      bulkhead.dispose();
      budget.dispose();
      monitor.dispose();
    }).not.toThrow();
    expect(defaultMetrics.names()).not.toContain('bulkhead');
    expect(defaultMetrics.names()).not.toContain('retryBudget');
  });
});
