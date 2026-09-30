/**
 * Two edge cases where the accumulator and the sketch disagreed.
 *
 * **`_max` was never updated by a zero record.** `_max` starts at
 * `-Infinity` and values are non-negative, so a histogram whose every record is
 * `0` kept reporting `max` of `-Infinity` — a maximum below every one of its
 * own samples. The `record(0)` branch updated `_min` and not `_max`, and both
 * numbers then flow into `toJSON().max` and into the metrics series, so a
 * dashboard charted a maximum of `-Infinity` next to a minimum of `0`.
 *
 * **`mean` divided by a count the sum never saw.** `record(+Infinity)`
 * increments `_count` and then returns *before* adding to `_sum`, because an
 * infinity is deliberately kept out of the sum and counted in `infCount`
 * instead. Dividing `sum` by `count` therefore under-reported every histogram
 * that ever saw one: `[10, Infinity]` reported `mean` of **5** for a single
 * finite sample of 10. `NaN` and negatives are rejected by `record()`, so a
 * `+Infinity` record is the only way for `sum` and `count` to disagree.
 *
 * `percentile(1)` is **not** in this file as a fix. It returns the 100th
 * percentile, which `guides/powerHistogram.md` documents on purpose and calls
 * "the one to watch" — so it is characterised here, at the bottom, as a
 * decision that exists rather than a bug that got missed. A characterisation
 * test is what makes changing it a deliberate act instead of an accident.
 *
 * Values and counts throughout. No durations: the harness measures a ~28%
 * median spread, and nothing here is a timing property.
 */
import { describe, it, expect } from 'vitest';
import { PowerHistogram } from '../src/helpers/powerHistogram.js';

/** @returns {PowerHistogram} a histogram with 5 buckets over `[0, 10]`. */
const small = () => new PowerHistogram({ maxValue: 10, buckets: 5 });

describe('PowerHistogram max tracks a zero record', () => {
  it('reports max 0 for an all-zeros histogram, not -Infinity', () => {
    // The defect in one line. `min` was already correct on this branch, which
    // is what made it easy to miss: a histogram of zeroes is self-contradictory
    // only in `max`.
    const h = small();
    h.record(0);
    h.record(0);

    expect(h.count).toBe(2);
    expect(h.min).toBe(0);
    expect(h.max).toBe(0);
  });

  it('carries the corrected max into toJSON()', () => {
    // The row's claim that these flow into the serialised form. `-Infinity` is
    // not even JSON-representable, so a metrics backend receiving this got
    // `null`, `0` or a parse failure depending on the transport.
    const h = small();
    h.record(0);
    h.record(0);

    const json = h.toJSON();
    expect(json.max).toBe(0);
    expect(json.min).toBe(0);
    expect(json.count).toBe(2);
  });

  it('a zero recorded after a larger value does not pull max down', () => {
    // The other direction, and the reason the update is a comparison rather
    // than an assignment. An unconditional `this._max = 0` would pass the test
    // above and break this one.
    const h = small();
    h.record(7);
    h.record(0);
    h.record(3);

    expect(h.max).toBe(7);
    expect(h.min).toBe(0);
  });

  it('a lone zero leaves max at 0 rather than uninitialised', () => {
    const h = small();
    h.record(0);
    expect(h.max).toBe(0);
    // A single sample is simultaneously the min and the max, so the two must
    // agree — this is the invariant the branch was breaking for n > 1 too.
    expect(h.min).toBe(h.max);
  });

  it('merging two all-zeros histograms keeps max at 0', () => {
    // Fixed transitively: `merge` compares `other._max` against `this._max`,
    // and `-Infinity > -Infinity` is false, so before the fix no merge of any
    // number of all-zero histograms could ever produce a finite max.
    const a = small();
    const b = small();
    a.record(0);
    b.record(0);

    a.merge(b);
    expect(a.count).toBe(2);
    expect(a.max).toBe(0);
    expect(a.min).toBe(0);
  });

  it('a merge that adds a larger sample still wins', () => {
    // The counterpart to the merge test above: the fix must not make `merge`
    // sticky at 0.
    const a = small();
    const b = small();
    a.record(0);
    b.record(9);

    a.merge(b);
    expect(a.max).toBe(9);
    expect(a.min).toBe(0);
  });
});

describe('PowerHistogram mean divides by the records that carry a value', () => {
  it('averages the finite samples, not sum over all records', () => {
    // The defect: count 2, sum 10, mean 5 — for a single finite sample of 10.
    const h = small();
    h.record(10);
    h.record(Number.POSITIVE_INFINITY);

    expect(h.count).toBe(2);
    expect(h.sum).toBe(10);
    // `infCount` has no public getter — it is reachable through `toJSON()`.
    // First written as `h.infCount`, which is `undefined`, and the four
    // infinity tests failed on it rather than on anything about the mean.
    expect(h.toJSON().infCount).toBe(1);
    expect(h.mean).toBe(10);
  });

  it('count still reports every record, so the two are not conflated', () => {
    // The temptation in fixing a mean is to stop counting infinities, which
    // would make the mean right and `count` wrong. `count` is "records
    // recorded" and `infCount` is reported beside it precisely so a caller can
    // see how many carried no value.
    const h = small();
    h.record(10);
    h.record(Number.POSITIVE_INFINITY);

    const json = h.toJSON();
    expect(json.count).toBe(2);
    expect(json.count - json.infCount).toBe(1);
    expect(json.infCount).toBe(1);
  });

  it('averages several finite samples around an infinity', () => {
    const h = small();
    h.record(2);
    h.record(Number.POSITIVE_INFINITY);
    h.record(4);
    h.record(Number.POSITIVE_INFINITY);

    // (2 + 4) / 2 finite samples = 3, over 4 records.
    expect(h.mean).toBe(3);
    expect(h.count).toBe(4);
    expect(h.toJSON().infCount).toBe(2);
  });

  it('reports Infinity when every record was an infinity', () => {
    // A decision, and the one the old `0/0` would have answered as `NaN`. The
    // mean of a set of `Infinity` values is `Infinity`; `0` would claim the
    // samples were zero-sized, and `NaN` would claim the sketch is broken.
    const h = small();
    h.record(Number.POSITIVE_INFINITY);

    expect(h.count).toBe(1);
    expect(h.sum).toBe(0);
    expect(h.toJSON().infCount).toBe(1);
    expect(h.mean).toBe(Infinity);
  });

  it('still reports 0 for an empty histogram', () => {
    // The documented empty case, unchanged. `Infinity` is only reachable when
    // infinities were actually recorded.
    const h = small();
    expect(h.mean).toBe(0);
    expect(h.count).toBe(0);
  });

  it('leaves the mean of a histogram with no infinities alone', () => {
    // A guard on the guard: the fix must not perturb the ordinary case.
    const h = small();
    h.record(1);
    h.record(2);
    h.record(6);
    expect(h.mean).toBe(3);
  });

  it('leaves zeros out of it, so 0 and 10 average to 5', () => {
    // Zeros take the `n === 0` branch, which *does* add to `_sum` (`+= 0`),
    // so they are valued records and must stay in the denominator.
    const h = small();
    h.record(0);
    h.record(10);
    expect(h.mean).toBe(5);
  });

  it('a merged infinity is averaged the same way', () => {
    // `merge` adds `_count` and `_sum` and `_infCount` independently, so the
    // same disagreement is reachable through a merge and had to be fixed in
    // the getter rather than in `record()`.
    const a = small();
    const b = small();
    a.record(10);
    b.record(Number.POSITIVE_INFINITY);

    a.merge(b);
    expect(a.count).toBe(2);
    expect(a.toJSON().infCount).toBe(1);
    expect(a.mean).toBe(10);
  });
});

describe('percentile(1) is the maximum, and that is on purpose', () => {
  it('reads 1 as the fraction 1.0, i.e. p100', () => {
    // A characterisation, not an aspiration. `guides/powerHistogram.md` says:
    // "Any argument in (0, 1] is read as a _fraction_, so 1 means 1.0 = p100.
    // Use 0.5 for p50 or 50 for p50 — both work, but 1 is the one to watch."
    //
    // It is pinned here so that changing it is a deliberate decision with a
    // guide rewrite, rather than something a later reader mistakes for a bug
    // and "fixes" silently. A caller who wants p100 has two spellings and both
    // keep working; a caller who wants p1 has to write `1%`-style intent out
    // longhand, which is the cost the guide warns about.
    const h = new PowerHistogram({ maxValue: 100, buckets: 100 });
    for (let v = 1; v <= 100; v += 1) h.record(v);

    expect(h.percentile(1)).toBe(100);
    expect(h.percentile(100)).toBe(100);
    expect(h.percentile(0)).toBe(1);
  });

  it('still reads a fraction strictly inside (0, 1) as a fraction', () => {
    // The half of the range that is unambiguous, and the one a caller reaching
    // for p50 by habit actually types. Guarded because the two spellings share
    // one comparison, so a change to the boundary could take this with it.
    const h = new PowerHistogram({ maxValue: 100, buckets: 100 });
    for (let v = 1; v <= 100; v += 1) h.record(v);

    expect(h.percentile(0.5)).toBeCloseTo(50, -1);
    expect(h.percentile(50)).toBeCloseTo(50, -1);
  });
});
