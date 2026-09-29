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

### Decision: `min(max(4, ceil(maxEntries * 0.01)), floor(maxEntries / 4))`

The floor of 4 is what fixes the small-cache case, and the cap keeps the filter
meaningful on a large one. Checked against the measurement that motivated it, the
two formulas differ **exactly** where the benchmark lives:

| `maxEntries` | this formula | naive `floor(max * 0.01)` |
| -----------: | -----------: | ------------------------: |
|           10 |        **2** |                         1 |
|           40 |        **4** |                         1 |
|          100 |        **4** |                         1 |
|          500 |            5 |                         5 |
|        1 000 |           10 |                        10 |
|      100 000 |        1 000 |                     1 000 |

Above ~500 entries the two agree, which is why the ratio looks adequate in
Caffeine's published numbers. The entire argument for a floor lives below that —
and `bench/claims.js zipf` runs at `maxEntries: 40`, squarely in the regime
where `floor` gives a **one-slot** window and the measured failure happened.

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

### Decision: (a) — `admission: 'tynilfu'` is a no-op under `policy: 'slru'`

SLRU already wins this workload outright (89.4 % against LRU's 75.0 %), and
stacking the filter on top measurably _hurts_ it, to 70.9 %. The two mechanisms
are the same mechanism: running both means the newcomer pays for two admission
decisions and lands in neither's good space.

Concretely: with `policy: 'slru'` the sketch is not constructed at all, and the
option is documented as having no effect. This is the smallest change that makes
the combination predictable, and it removes a genuine footgun — a user composing
"the two scan-resistant options" currently gets the worse of each.

Option (b) — letting the window _replace_ SLRU's probation region — is the more
elegant design and is not chosen, because it couples two independently useful
policies and would make `slru` depend on an admission option it does not
otherwise need. Option (c), leaving them independent and merely documented, is
the status quo, and is what the measurement argues against.

**This is a behaviour change to a shipped option**, and it makes the
combination do _less_ than a user might expect today. It belongs under
**Breaking**, not Improved, with the measurement quoted.

**3. Whether `tinylfu` should stay shippable at all.** If the window is not
implemented, the honest position is the current one — off by default,
documented as not recommended, with the numbers published. That is what the
release note says today, and it should not change until this note is resolved
either way.

**Both open decisions are now made**, so this note blocks on neither. What
remains is implementation, and it is larger than the plan row's 360 LOC implies.

### Scope the implementation must cover

Measured by reading `powerCache.js`, not estimated. The window is a **second LRU
region**, not a filter tweak, and all of these have to change together:

- a window list with its own head/tail and its own weight accounting —
  `_currentWeight` is a single pool-wide total today;
- `maxEntries` / `maxWeight` must apply to **main space only**, or the window
  silently shrinks the cache's stated capacity;
- the insert path must land the challenger in the window and arbitrate _there_,
  rather than insert-then-refuse as it does now;
- iteration (`keys` / `entries` / `values` / `forEach`), `size` and `stats()`
  must decide whether the window is visible. Making it visible is arguably more
  honest, and is the larger change;
- `dispose()` / `clear()` must free both regions, or the window leaks nodes
  outside the pool's accounting.

That is a structural change to a hot path, and the four acceptance criteria
below must be met by the whole thing rather than by a slice. The honest estimate
is a session of its own plus the benchmark loop, not a patch.

### Three rules the implementation must get, found by attempting it

A first attempt was made and **reverted** — it reached 4 of the acceptance
criteria, was still failing scan resistance (9 survivors against the 30 the test
requires), and had not touched `clear`/`dispose`, iteration, `size` or `stats`.
Reverting rather than committing a red tree was the right call, but three rules
came out of it that the design above did **not** state, and rediscovering them by
running the test one at a time is exactly the cost this note exists to remove.

**1. The challenger wins ties (`>` not `>=`) — but only inside the window.** The
old rule refused a brand-new key at estimate 0 against an incumbent also at 0, so
everything was refused. Inside the window the challenger is an _established_ key:
it was admitted and has been there long enough to be challenged, so a tie means
"no evidence either is better" and discarding it discards the only evidence the
filter has. Keeping `>=` here is not a small pessimism — measured, a caller that
fills a cache and _then_ reads it lost every key written after the first few,
because they all tie at estimate 1.

**2. Only arbitrate once main space is full.** This rule is not in W-TinyLFU's
_description_ and it is the one the implementation could not do without. While
main space has room the filter has nothing to protect, and a frequency
comparison during a bulk fill has no signal to work from — every freshly-written
key sits at estimate 1, so every comparison is a tie and the churn evicts the
entry the previous `set` just promoted. Measured: a 40-key warm ended with **5**
entries instead of 40. Caffeine's `admit` makes the same check
(`mainSpace.size() < maximum` admits unconditionally); it is why its warm-up
works at all.

**3. `victim === challenger` is the cold cache, not an error.** With no main
space yet, the eviction candidate is the head, and the head is the window's own
oldest node. Comparing it with itself is meaningless, and _evicting_ it is
catastrophic: the unlink removes the challenger from `_map` and it never comes
back. Measured as a fresh cache silently losing every key after the first few.

**Two implementation traps that produced a silently inert feature rather than an
error**, recorded because both would again look like "the filter is just weak":

- **Reading constructor state before it is assigned.** The window was armed from
  `this._sketch` several lines above the sketch's own construction, so the window
  was inert and the only symptom was a passing test suite.
- **Advancing a cursor after the unlink it was derived from.** `_windowStart` was
  updated _after_ the node it pointed at had been unlinked and its links nulled,
  so the first promotion dereferenced null. The fix — advance the cursor first —
  is the general rule, and the head case needs its own guard: when the window's
  oldest node _is_ the head, `prev` is null and splicing through it throws. The
  first promotion of a cold cache hits exactly that case.

The third trap and the second share a root: the window lives at the tail of the
main list precisely so that main space's eviction cursor is untouched by it, and
that sharing is what makes these edges reachable.

### A second attempt, and what it got right before it stopped

Started from this note rather than from a constructor, which is the point of
writing it. It got three things right that the first attempt had wrong, and
each is a mistake worth naming because none of them produces an error:

**Rule 2b — "full" means the _total_ count, window included.** The first
attempt tested main space alone. That is the natural reading and it is wrong:
the window is admission slack, not capacity on top of `maxEntries`, so a
main-only test reads `36 >= 40`, never arbitrates, admits every scan key, and
the cache churns through its working set one scan key at a time. Measured: **9 of
40** survivors against the 30 the test requires.

**The window counts _against_ `maxEntries`.** Excluding it — the same mistake,
in the eviction sweep this time — grew a `maxEntries: 10` cache to 12. A cache
reporting `size: 12` under a limit of 10 is lying, and `maxEntries` is the one
number callers size their working sets against. Caffeine has the same property:
the window is drawn from the same budget as main space.

**Promotion must unlink before re-appending.** `_append` splices at the tail and
does not remove, so promoting a still-linked node leaves it in two places at
once. The list stops being a list, and the symptom is a 40-key warm ending with
**6** entries instead of 40 — no exception, just a cache that quietly does not
grow.

With those fixed, scan resistance reached **30 of 40**, against a requirement of
more than 30 — and then the work stopped, with the tree reverted rather than
committed red.

**Where the next attempt starts, precisely.** An unresolved window-accounting
bug: after a warm and a read pass, `_windowSize` reads **negative** (`-16`), so
`_promoteFromWindow` ran about twenty times against a window that holds four.
`node.inWindow` was true on more nodes than the window contained.

**Root-caused, in a standalone model rather than in the cache.** The window is
_positional_: it is the last `_windowSize` nodes, `_windowStart` to tail. That
makes the invariant **every splice must land in the right region**, and two of
the three did not:

1. **A main-space recency bump appended at the tail.** `_moveToTail` on a
   node already in main space moved it to the MRU end of the _whole list_ —
   which is inside the window region. The node was not counted and not flagged,
   so the region and the counter stopped describing the same set.
2. **The window's promote branch re-appended at the tail.** Same error, in
   `_evictWindowOldest`: a key promoted out of the window was appended to the
   tail, putting a main-space node back inside the window region.

`_promoteFromWindow` — the one path that spliced to _immediately before
`_windowStart`_ — was already correct, which is why the defect looked like a
counter bug rather than a geometry one: `_windowSize` is the visible symptom of
a node having crossed the boundary.

**The fix is one shared splice, used in all three places.** A `toMainSpace(node)`
that unlinks and re-inserts immediately before `_windowStart` (falling back to
the tail when the window is empty, and fixing `_head`/`_evictionCandidate` when
there is no main space at all). `append` to the tail is then reserved for
**window admission** — which is the only thing that belongs there — and
`_moveToTail` becomes "promote if in the window, else move to the MRU end of
main space" rather than "always move to the tail".

Verified in the model before touching the cache: `size` 40, `wSize` 4 after a
40-key warm, `wSize` 0 after a read pass, and an integrity check (the last
`wSize` nodes are exactly the flagged ones, with `_windowStart` at the boundary)
reporting `ok` throughout. Before the fix the same check read `BROKEN` _during
the warm_, before any read happened — which is why the counter ran away on reads
that were not themselves at fault.

**Worth keeping as a rule:** when a structure is defined by _position_ in a list
rather than by a field on its members, every mutation of that list has to be
checked against the boundary. A node carrying a correct boolean can still be on
the wrong side of it.

**Applied to the cache, the counter is fixed** — `_windowSize` now reads 4 after a
40-key warm and stays 4 across reads, where it previously went to `-16`. That
was the goal of the isolated work and it is met. **What is not yet explained is
the cache's own behaviour with the fix in place**: the same 40-key warm leaves
`_map.size` at 5, so main space is not accumulating as the model says it should.
The model's arbitration — no victim on a cold cache, promote unconditionally
below capacity — matches the code, so the divergence is somewhere in how the
real cache's eviction sweep, the sketch, or the reuse of `_evictionCandidate`
interacts with a region boundary the model does not have. **The next step is
therefore to extend the model to include the sweep**, not to add another rule to
the cache: the model has now caught one bug the cache hid, and it will only catch
this one if it covers the same ground.

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
