/**
 * GATE-018: `PowerBulkhead.maxConcurrency` measured, and it is not a missing
 * comparison.
 *
 * The row recorded an observation without a conclusion: with `maxConcurrency: 2`
 * and several concurrent `tryRun`s, `active` reported 4. It said explicitly that
 * whether that was a defect or whether `maxConcurrency` meant something other
 * than the name said was "not established here", and that the interactions test
 * asserted it in neither direction — a ceiling assertion would be a claim
 * nobody could back, and a no-ceiling assertion would bless a number nobody
 * understood.
 *
 * Measured, per partition, with `tryRun` (which refuses rather than queueing):
 *
 *     partitions 1, maxConcurrency 2, try 6  ->  accepted 2, active 2
 *     partitions 2, maxConcurrency 2, try 8  ->  accepted 4, active 4
 *     partitions 4, maxConcurrency 2, try 12 ->  accepted 8, active 8
 *
 * So the global ceiling is `maxConcurrency * partitions`, `active` counts
 * in-flight tasks across the whole bulkhead, and the original observation was two
 * or three concurrent `tryRun`s spread across partitions — correct behaviour
 * read as a missing comparison. `guides/powerBulkhead.md` already says "Maximum
 * concurrent tasks allowed **per partition**", in both the option table and the
 * bullet list, so the code, the type and the documentation agree.
 *
 * The `run()` direction, which does queue, is `maxConcurrency + queueCapacity`
 * per partition — also as documented:
 *
 *     1 partition,  maxConc 2, queue 2, submit 6  ->  ran 4,  refused 2, pending 2
 *     1 partition,  maxConc 2, queue 9, submit 12 ->  ran 11, refused 1, pending 9
 *     2 partitions, maxConc 2, queue 2, submit 10 ->  ran 8,  refused 2, pending 4
 *
 * So the row can now assert a direction. These are **counts**, not durations:
 * the tasks are promises released in waves, and nothing here depends on how long
 * anything took.
 */
import { describe, it, expect } from 'vitest';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';

/**
 * A bulkhead whose tasks are promises the test releases explicitly, so "active"
 * is observable and nothing is left dangling.
 *
 * @param {Object} options
 */
function makeBulkhead(options) {
  return new PowerBulkhead({ maxConcurrency: 1, minSize: 1, maxSize: 1, lazy: false, ...options });
}

/**
 * Submit `count` `tryRun`s and report how many were accepted.
 *
 * `tryRun` returns `null` on refusal rather than throwing, and the row records
 * that shape as part of why the bulkhead is a *runner* and not a permit holder.
 *
 * @param {PowerBulkhead} bulkhead
 * @param {number} count
 */
function submitTryRuns(bulkhead, count) {
  /** @type {Array<() => void>} */
  const held = [];
  let accepted = 0;
  for (let i = 0; i < count; i += 1) {
    const p = bulkhead.tryRun(() => new Promise((resolve) => held.push(resolve)));
    if (p) {
      accepted += 1;
      void p.catch(() => {});
    }
  }
  return { accepted, release: () => held.splice(0, held.length).forEach((r) => r()) };
}

describe('GATE-018: maxConcurrency is a per-partition ceiling', () => {
  it('admits maxConcurrency per partition, and no more', () => {
    // The global ceiling is the product, which is what the original observation
    // missed: `active: 4` with `maxConcurrency: 2` is two partitions' worth.
    for (const [partitions, maxConcurrency, expected] of [
      [1, 2, 2],
      [2, 2, 4],
      [4, 2, 8],
      [3, 1, 3],
    ]) {
      const bulkhead = makeBulkhead({ partitions, maxConcurrency, queueCapacity: 8 });
      const { accepted, release } = submitTryRuns(bulkhead, expected + 2);
      expect(accepted, `partitions ${partitions}, maxConcurrency ${maxConcurrency}`).toBe(expected);
      expect(bulkhead.stats().active).toBe(expected);
      release();
      bulkhead.dispose();
    }
  });

  it('tryRun refuses rather than queueing, so pending stays 0 at the ceiling', () => {
    // The second half of the row's question. At the limit, `tryRun` returns
    // `null` and nothing is enqueued — which is why `pending` read 0 in the
    // original observation and looked like the counter was not tracking work.
    const bulkhead = makeBulkhead({ partitions: 1, maxConcurrency: 2, queueCapacity: 4 });
    const { accepted, release } = submitTryRuns(bulkhead, 6);
    expect(accepted).toBe(2);
    expect(bulkhead.stats().pending).toBe(0);
    expect(bulkhead.isFull).toBe(false); // queue is empty, so nothing is full
    release();
    bulkhead.dispose();
  });

  it('run() queues up to queueCapacity per partition and refuses the rest', async () => {
    // The `run()` shape, where the budget really is `maxConcurrency +
    // queueCapacity` per partition. Asserted on the refusal count rather than on
    // `isFull`, which is a per-partition property and would hide the total.
    const cases = [
      { partitions: 1, queueCapacity: 2, submit: 6, expectedRan: 4 },
      { partitions: 1, queueCapacity: 9, submit: 12, expectedRan: 11 },
      { partitions: 2, queueCapacity: 2, submit: 10, expectedRan: 8 },
    ];
    for (const { partitions, queueCapacity, submit, expectedRan } of cases) {
      const bulkhead = makeBulkhead({ partitions, maxConcurrency: 2, queueCapacity });
      /** @type {Array<() => void>} */
      const held = [];
      const outcomes = [];
      for (let i = 0; i < submit; i += 1) {
        outcomes.push(
          bulkhead
            .run(() => new Promise((resolve) => held.push(resolve)))
            .then(
              () => 'ran',
              () => 'refused'
            )
        );
      }
      // Let the first batch take its permits and the rest queue or be refused.
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Release in waves: a settled task admits a queued one, which then needs
      // releasing too. A single pass deadlocks on the second wave — which is
      // what the measurement script did first, and it is the reason this is
      // written as a loop rather than one `Promise.all` at the end.
      for (let wave = 0; wave < 30 && held.length > 0; wave += 1) {
        held.splice(0, held.length).forEach((r) => r());
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      const settled = await Promise.all(outcomes);
      expect(
        settled.filter((o) => o === 'ran').length,
        `queue ${queueCapacity}, ${partitions} partition(s)`
      ).toBe(expectedRan);
      expect(settled.filter((o) => o === 'refused').length).toBe(submit - expectedRan);
      bulkhead.dispose();
    }
  });

  it('isFull means every partition is at its queue budget', async () => {
    // Measured alongside: `isFull` was `false` at the *concurrency* ceiling
    // with an empty queue, and `true` once the queues filled. The two ceilings
    // are different things and `isFull` is about the second.
    const bulkhead = makeBulkhead({ partitions: 2, maxConcurrency: 2, queueCapacity: 1 });
    const held = [];
    const outcomes = [];
    for (let i = 0; i < 8; i += 1) {
      outcomes.push(
        bulkhead
          .run(() => new Promise((resolve) => held.push(resolve)))
          .then(
            () => 'ran',
            () => 'refused'
          )
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 2 partitions x (2 active + 1 queued) = 6 admitted, 2 refused.
    expect(bulkhead.isFull).toBe(true);
    expect(bulkhead.stats().pending).toBe(2);
    for (let wave = 0; wave < 30 && held.length > 0; wave += 1) {
      held.splice(0, held.length).forEach((r) => r());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await Promise.all(outcomes);
    bulkhead.dispose();
  });
});
