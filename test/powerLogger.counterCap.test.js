/**
 * `PowerLogger.incrementCounter` is bounded — OBS-012.
 *
 * The defect: `_counters` had no cap and no eviction, so a per-request key grew it
 * for the life of the logger, and `getDebugCounters` `Object.assign`'d the whole
 * thing on every read. A logger is usually held for the life of the process, so
 * "for the life of the logger" is the whole problem.
 *
 * **The property under test is which key gets dropped, not that a drop happens.**
 * A cap that removed an arbitrary key would pass "the map stays bounded" and would
 * be worse than useless — it would remove the counters worth reading. Two rules are
 * pinned below and they are the design:
 *
 * 1. **Re-arming an existing key does not make it newly evictable.** If insertion
 *    order alone decided eviction, a counter incremented ten thousand times would be
 *    the oldest entry and the first thrown away — the cap would remove exactly what
 *    it exists to keep. This is the failure mode that made "evict the oldest" sound
 *    wrong until the increment path was read.
 * 2. **A new key evicts the one gone longest without being seen**, which under a
 *    per-request-key workload is the churn rather than the signal.
 *
 * `debug` must be on for any of it to run: `incrementCounter` is a no-op below level
 * 1, so a cap asserted without that would pass vacuously.
 */
import { describe, it, expect } from 'vitest';
import { PowerLogger } from '../src/index.js';

/** A logger with debug on, so `incrementCounter` is not a no-op. */
const debugLogger = (options = {}) => new PowerLogger({ level: 3, ...options });

describe('PowerLogger counter cap', () => {
  it('bounds the map under a per-request key workload', () => {
    // The defect, stated as an observable: 5,000 distinct keys used to leave 5,000
    // entries behind. The cap is what makes the number independent of traffic.
    const logger = debugLogger({ maxCounters: 10 });
    for (let i = 0; i < 5000; i += 1) logger.incrementCounter(`request-${i}`);
    expect(Object.keys(logger.getDebugCounters()).length).toBe(10);
  });

  it('defaults to a bound rather than to unbounded', () => {
    // A cap nobody opts into is not a cap. Asserted on the default because the row's
    // point is that the *default* leaked — a caller who never heard of the option is
    // the one who was affected.
    const logger = debugLogger();
    for (let i = 0; i < 3000; i += 1) logger.incrementCounter(`k${i}`);
    expect(Object.keys(logger.getDebugCounters()).length).toBe(1000);
  });

  it('keeps a hot counter and drops the churn', () => {
    // The property, not the bookkeeping. `hot` is incremented more than the cap is
    // big, so anything that evicts by recency-of-last-increment or by count throws
    // it away first.
    const logger = debugLogger({ maxCounters: 5 });
    for (let round = 0; round < 50; round += 1) {
      logger.incrementCounter('hot');
      logger.incrementCounter(`churn-${round}`);
    }
    const counters = logger.getDebugCounters();
    expect(counters.hot).toBe(50);
    // The five survivors are `hot` plus the four most recent churn keys.
    expect(Object.keys(counters).sort()).toEqual(
      ['churn-46', 'churn-47', 'churn-48', 'churn-49', 'hot'].sort()
    );
  });

  it('a re-armed key is refreshed, so it survives while untouched keys do not', () => {
    // The rule that makes the policy correct, and it is invisible without a workload
    // that re-arms one key while churning others. `old` is inserted first, so an
    // eviction that used insertion order would drop it *while it is still being
    // counted* — the cap would keep keys nothing has touched since the first
    // request and discard the one being reported on.
    const logger = debugLogger({ maxCounters: 3 });
    logger.incrementCounter('old');
    logger.incrementCounter('stale-a');
    logger.incrementCounter('stale-b');
    for (let i = 0; i < 20; i += 1) {
      logger.incrementCounter('old');
      logger.incrementCounter(`churn-${i}`);
    }
    const counters = logger.getDebugCounters();
    expect(counters.old).toBe(21);
    expect(Object.keys(counters)).toHaveLength(3);
    // And the survivors are `old` plus the two most recent churn keys - not `old`
    // plus the two keys inserted before it.
    expect(Object.keys(counters).sort()).toEqual(['churn-18', 'churn-19', 'old']);
  });

  it('reports how many counters were dropped, and a silent cap is not one', () => {
    // A logger quietly discarding keys looks identical to a logger nobody
    // incremented. Without this the only way to notice is to count entries by hand
    // and guess at the missing ones.
    const logger = debugLogger({ maxCounters: 3 });
    for (let i = 0; i < 10; i += 1) logger.incrementCounter(`k${i}`);
    // 10 distinct keys into a cap of 3: 3 survivors, 7 evicted.
    expect(logger.getDebugCountersDropped()).toBe(7);
    expect(Object.keys(logger.getDebugCounters())).toHaveLength(3);
  });

  it('resets the drop count with the counters', () => {
    // A counter that survives a reset while everything else does not reports on a
    // previous life — the `PowerCache._rejectedAdmission` shape.
    const logger = debugLogger({ maxCounters: 2 });
    for (let i = 0; i < 6; i += 1) logger.incrementCounter(`k${i}`);
    expect(logger.getDebugCountersDropped()).toBeGreaterThan(0);
    logger.resetDebugCounters();
    expect(logger.getDebugCountersDropped()).toBe(0);
    expect(logger.getDebugCounters()).toEqual({});
  });

  it('maxCounters: 0 disables the cap, for a caller who has chosen that', () => {
    // The escape hatch, and it is opt-in rather than a default: a caller with a
    // genuinely bounded key set should be able to say so.
    const logger = debugLogger({ maxCounters: 0 });
    for (let i = 0; i < 500; i += 1) logger.incrementCounter(`k${i}`);
    expect(Object.keys(logger.getDebugCounters()).length).toBe(500);
    expect(logger.getDebugCountersDropped()).toBe(0);
  });

  it('is still a no-op below debug level 1, so the cap costs nothing there', () => {
    // The cheap half. A logger nobody is debugging must not accumulate counters at
    // all, capped or not — and this is the shape a per-request key actually takes in
    // production, where debug is off.
    const logger = new PowerLogger({ level: 0, maxCounters: 4 });
    for (let i = 0; i < 100; i += 1) logger.incrementCounter(`k${i}`);
    expect(logger.getDebugCounters()).toEqual({});
    expect(logger.getDebugCountersDropped()).toBe(0);
  });

  it('hands out a snapshot the caller cannot use to corrupt the ledger', () => {
    // `getDebugCounters` returning the backing store would let a caller delete a key
    // by assigning to the object, which is a different bug from this row and would be
    // introduced by the obvious "optimisation".
    const logger = debugLogger();
    logger.incrementCounter('real');
    const snapshot = logger.getDebugCounters();
    snapshot.injected = 99;
    delete snapshot.real;
    expect(logger.getDebugCounters()).toEqual({ real: 1 });
  });

  it('rejects an unknown option rather than ignoring it', () => {
    // The whitelist is why `maxCounter` (singular) cannot silently leave the map
    // unbounded while the caller believes it is capped.
    expect(() => new PowerLogger({ level: 3, maxCounter: 10 })).toThrow(/maxCounter/);
  });

  it('is honoured when it is the *only* option passed', () => {
    // **A defect this option shipped with in its first minute.** The constructor
    // recognises an options object only when it carries a known key, and the list
    // that does the recognising did not include `maxCounters` — so
    // `new PowerLogger({ maxCounters: 500 })` took the numeric path and the cap was
    // silently ignored, which is the failure mode of an option that appears to work.
    // **Every other case in this file passes `level` alongside it, and that is what
    // hid the defect from the test written to catch it.** The first version of this
    // case was `new PowerLogger({ maxCounters: 4, level: 3 })` — which contains a
    // recognised key, so the object was detected however the list was written, and
    // the mutant that removed `maxCounters` from it survived all 11 tests. The
    // option must be passed **alone**.
    //
    // Debug is enabled afterwards rather than in the constructor, because including
    // `level` here is precisely what defeats the check.
    const logger = new PowerLogger({ maxCounters: 4 });
    logger.setDebugLevel(3);
    for (let i = 0; i < 50; i += 1) logger.incrementCounter(`k${i}`);
    expect(Object.keys(logger.getDebugCounters()).length).toBe(4);
  });
});
