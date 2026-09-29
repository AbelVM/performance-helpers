# 0001 — W-TinyLFU admission window

**Status:** Proposed. Blocked on one decision (window size), not on the mechanism.
**Affects:** `PowerCache` `{ admission: 'tinylfu' }` (`src/helpers/powerCache.js`).
**Evidence:** `node bench/claims.js zipf`. Every number below is from that run.

## The problem

`admission: 'tinylfu'` is measurably **worse than not using it**, which is not
what an admission filter is for:

| Configuration                            | Working-set hit rate |     Survivors |
| ---------------------------------------- | -------------------: | ------------: |
| `policy: 'lru'`                          |               75.0 % |     17.2 / 40 |
| `policy: 'lru'`, `admission: 'tinylfu'`  |               71.0 % |     15.2 / 40 |
| **`policy: 'slru'`**                     |           **89.4 %** | **33.0 / 40** |
| `policy: 'slru'`, `admission: 'tinylfu'` |               70.9 % |     15.2 / 40 |

The cold-start case is worse than a loss; it is a collapse. On a cold 40-entry
cache preceded by a 460-key scan burst, `tinylfu` measured a **2.5 % hit rate
against plain LRU's 66.4 %**, retaining 1.7 of 40 working-set keys.

The current code refuses an insert when the victim's estimate is `>=` the
challenger's:

```js
const challenger = this._sketch.estimate(key);
if (incumbent && this._sketch.estimate(incumbent.key) >= challenger) {
  this._rejectedAdmission += 1;
  return this;
}
```

A brand-new key has an estimate of `0`. In a cold sketch _every_ estimate is
`0`, so `0 >= 0` holds and the insert is refused. The failure runs in two steps:

1. Below capacity, the filter is not consulted at all (correctly — admission is
   about what to _displace_). The 40 one-shot scan keys fill the cache.
2. At capacity, the working set is refused every time, because it is a new key
   at `0` against an incumbent also at `0`.

The working set can never enter. There is no state from which it recovers,
because the only thing that would raise its estimate is being admitted.

## What has been tried

**Flipping `>=` to `>` — implemented, measured, reverted.** The "doorkeeper"
refinement: a challenger is refused only when the incumbent is _proven_ hotter,
so an unproven newcomer is a candidate rather than a competitor. No structural
change, and it does help one case:

|                                     | before |   with `>` |
| ----------------------------------- | -----: | ---------: |
| sustained Zipf working-set hit rate | 70.9 % | **77.0 %** |
| cold-start hit rate                 |  2.5 % |  **2.7 %** |

77.0 % finally beats plain LRU's 75.0 %, which removes the "worse than not
using it" result for the sustained mix. The cold-start case is unmoved: 2.5 %
to 2.7 % is noise. It was reverted because a partial fix that leaves the
catastrophe in place, while contradicting an existing test, is not a good
trade.

**The important thing this measurement established: the tie rule is part of the
problem and not all of it.** No comparison operator can fix the cold-start
case, because the cold-start case is not about ties — it is about a new key
being refused at all. Something has to accept unconditionally.

**Short half-life — retracted.** A synthetic probe driving `SmallLfuSketch`
directly suggested the reset window was destroying the frequency signal. It was
an artefact of the probe: the probe did not resemble the cache's access pattern.
Sweeping the real shipped path over `sampleSize` 200 → 25 600 gives a
working-set hit rate of 36.8 % at _every_ multiple. The half-life is not the
limiting factor.

**Count-Min collisions inverting the ranking — retracted.** A second probe
suggested one-shot keys outranking hot ones. Widths 64 → 1024 and key spaces
20 → 20 000 did not reproduce it as a collision effect. It is better explained
by the refusal rule above: the zero-estimate keys are the problem, and their
non-discriminative ranking is a consequence, not a separate sketch defect.

**The sketch is sound.** `test/smallLfu.test.js` asserts, at a production-shaped
half-life, that a recurring key outranks a one-shot one. Do not "fix" this by
re-tuning the sketch; two separate investigations already concluded that the
sketch is not where the fault is.

## The proposal: W-TinyLFU's admission window

The "W" in W-TinyLFU is a small LRU **window** at the MRU end that accepts new
keys unconditionally. Scan traffic is absorbed there and dies; the frequency
filter only ever arbitrates _the window's victim_ against a _main-space
victim_, so the filter is never asked "is this new key worth more than the
hottest established key?" — which is the question it answers worst.

Structurally:

```
[ main space .................. ][ window ]
        ^ filter arbitrates        ^ accepts unconditionally
```

- A challenger that misses always lands in the **window**, never in main space
  directly. The window is a real LRU of bounded size.
- When the window is full, the filter compares the **window's LRU entry**
  (challenger) against the **main space's eviction candidate**. This is the
  comparison TinyLFU is good at: both are established keys, so neither is a
  0-estimate newcomer, and a tie is a genuine tie rather than a cold sketch.
- If the challenger wins, it is promoted into main space and the main victim is
  evicted. If it loses, the window entry is simply dropped.

The cold-start case is fixed by construction: a new key is admitted to the
window unconditionally, and every one-shot scan key displaces the previous
scan key inside the window rather than a working-set key in main space. The
working set, once it arrives, is already in main space and the scan never
reaches it.

This is a well-established mechanism, not a novel one. The value of this note
is in the parts of it that are _not_ determined by the paper.

## What is not decided

**1. The window size.** The blocked decision. The obvious candidates are a fixed
count (1 %, 8 entries) or a ratio of `maxEntries` (the reference
implementation uses `1 %`). Neither is obviously right for this cache:

- `PowerCache` is frequently small. A 1 %-of-`maxEntries` window on a 40-entry
  cache is **0.4 entries**, which rounds to nothing, and a zero-entry window is
  the current behaviour with extra steps. Any ratio needs a floor.
- The window's job is to absorb scan bursts, so its size should be bounded by
  the _burst_, not by the cache. That argues for a fixed floor (say 4–8) with
  an optional ratio above it.

**A proposal, not a decision: `max(4, ceil(maxEntries * 0.01))`, capped at
`maxEntries / 4` so the window can never become a meaningful fraction of main
space.** The floor is what fixes the small-cache case; the cap is what keeps
the filter meaningful on a large one.

**The naive ratio has already been implemented, measured, and reverted.** An
attempt used `floor(maxEntries * 0.01)` — Caffeine's ratio, which is where
these numbers come from — and it made scan resistance **measurably worse**:
`test/powerCache.tinylfu.test.js` dropped from above 30/40 retained to 22/40,
and the tie and refusal-count cases failed with it.

The reason is structural, and it is the strongest evidence available for this
decision, so it is worth stating precisely. On a small cache
`floor(maxEntries * 0.01)` clamps to **1**, so the window holds a single key —
and that key is challenged on the very next insert. **It therefore never
survives long enough to be seen twice, let alone to accumulate frequency.** The
unfiltered region has no room to absorb anything; every arrival evicts the
previous arrival, and the window degenerates into a one-slot buffer with a
filter attached. A ratio is only meaningful at the large capacities Caffeine's
figures were measured at.

Two things follow, and both constrain any future attempt:

1. **The window must be sized in absolute terms** — enough to hold the scan
   burst it exists to absorb — or grown relative to observed arrival rate. A
   pure ratio cannot work, because the failure mode is _too small_, and no
   multiplicative term fixes a floor.
2. **The promotion rule must compare the newcomer against the window's member**,
   not assume the window drains one entry per insert. A one-slot window with a
   per-insert drain is the same defect wearing a different hat.

**2. Interaction with `policy: 'slru'`.** The data shows `slru + tynilfu` is
currently the _worst_ variant measured (70.9 % against `slru` alone's 89.4 %).
SLRU already has a probationary region that absorbs one-shot traffic, so the
window and the probation region are doing the same job, and having both is at
best redundant.

There are three defensible answers, and this is a real choice rather than an
obvious one:

- **(a) Make `admission: 'tinylfu'` a no-op under `policy: 'slru'`.** SLRU
  already wins the scan workload; stacking them measurably hurts. This makes
  the combination predictable and stops a user composing both from getting the
  worse of each.
- **(b) Let the window replace SLRU's probation region** when both are set, so
  there is exactly one place a newcomer can enter. More correct, more coupling.
- **(c) Leave them independent** and document that they are alternatives.

(a) is the smallest change and the one the measurements support. It also
removes a genuine footgun. But it is a behaviour change to a shipped option,
so it wants its own decision.

**3. Whether `tinylfu` should stay shippable at all.** If the window is not
implemented, the honest position is the current one — off by default,
documented as not recommended, with the numbers published. That is what the
release note says today, and it should not change until this note is resolved
either way.

## How to validate

Any implementation must clear all four, measured with `bench/claims.js zipf`:

1. **Cold-start hit rate** beats plain LRU's 66.4 %. The current 2.5 % is the
   thing being fixed; a change that improves the sustained mix while leaving
   this at 2 % has missed.
2. **Sustained hit rate** at or above the doorkeeper's 77.0 %, so the window
   does not give back the one gain that was measured.
3. **`slru` alone stays at 89.4 %.** The window must not degrade the
   configuration that already wins.
4. **No regression in counter arithmetic** — the existing
   `test/smallLfu.test.js` and `test/powerCache.admission.test.js` stay green,
   and the new tests use `realistic()` (a production-shaped half-life) rather
   than `wide()`. A test built on a disabled reset would not catch this defect,
   which is how the original one shipped.

## Why this is a note and not a patch

Three separate mechanism hypotheses about this defect were proposed and all
three were wrong. The two that survived were the ones measured against the
shipped path and reproduced across a parameter sweep; the ones that failed came
from synthetic probes that did not resemble the real workload. Any future
diagnosis of this area should be required to reproduce against `PowerCache`
itself and to survive a sweep.

That is also why the estimates in the review are worth distrusting — the
window is a structural change with a size choice, an interaction rule, and its
own tests, and the 360 LOC in the plan row does not include the two decisions
above. Writing the code first and picking the window size by experiment would
be repeating the mistake the three retracted hypotheses represent.
