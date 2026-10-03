# Review 4 — agent and multi-agent base modelling: rejected, with the evidence

> **What this document is.** The record of a domain this repository declined,
> and the two rows that survived the review. It was, one revision ago, a
> 35-row proposal to add a belief-desire-intention agent layer; it is now the
> evidence that killed 33 of those rows, written down so the next person does
> not spend a session rediscovering that `js-son-agent` exists.
>
> **No code changed at any point.** `src/`, `test/`, `guides/` and `adr/` are
> untouched by this document. Two rows were added to `review.md`'s plan table
> (`CACHE-020`, `POOL-013`) and nothing else _by me_ — verified by diff against
> a backup. A third change appeared in the same diff minutes later and belongs
> to another session; §8 has the details, because that is the hazard this file
> exists partly to record.
>
> **There is no plan table here, on purpose.** The proposal's 35-row table is
> gone. §8 lists what moved to `review.md` and §10 records the rows that were
> dropped rather than filed, because a rejected row that vanishes is a decision
> the next person will re-litigate.
>
> **Provenance marks**, carried over from the proposal and still load-bearing,
> because most of the interesting claims are about _other_ projects and a reader
> has no way to tell a registry API from a plausible-sounding memory:
>
> | Mark             | Means                                                                                                                  |
> | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
> | **[verified]**   | Read in this repository, or a registry API, in this session. Reproducible.                                             |
> | **[source]**     | From a named external source, cited. "Snippet" means only an abstract or registry record was read, never a full paper. |
> | **[mechanism]**  | My reasoning from a cited source or verified code. Not itself sourced.                                                 |
> | **[hypothesis]** | Unmeasured.                                                                                                            |
>
> **What the proposal got wrong is in §4 and §5, not buried.** The single most
> useful thing in this file is that its own author looked for a library before
> recommending one, found it, and had to withdraw three quarters of the work.

---

## Table of Contents

- [0. Decision](#0-decision)
- [1. What was proposed](#1-what-was-proposed)
- [2. Scope: this package does not do this](#2-scope-this-package-does-not-do-this)
- [3. Market: the niche is the size of our own audience](#3-market-the-niche-is-the-size-of-our-own-audience)
- [4. The research error: the library we did not look for](#4-the-research-error-the-library-we-did-not-look-for)
- [5. What the proposal got wrong about itself](#5-what-the-proposal-got-wrong-about-itself)
- [6. Verified findings that survive](#6-verified-findings-that-survive)
- [7. Measurements taken, and withdrawn](#7-measurements-taken-and-withdrawn)
- [8. The two rows that moved to review.md](#8-the-two-rows-that-moved-to-reviewmd)
- [9. Preconditions for revisiting](#9-preconditions-for-revisiting)
- [10. Dropped rows, recorded](#10-dropped-rows-recorded)

---

## 0. Decision

**Declined.** This repository does not take an agent, multi-agent, BDI, or
agent-based-modelling domain. Two rows survive and live in `review.md`; the
other 33 do not, for reasons that are recorded below rather than deleted.

The decision rests on four findings, in descending order of how much they
mattered:

1. **The scope does not fit.** `package.json`'s description is "Performance
   toolbox" and all 23 of its keywords are about cost and concurrency
   **[verified]**. The proposal was about semantics.
2. **The market does not exist at our scale.** The entire dependency-free
   JavaScript BDI niche is **1,319 downloads/year**; this package is **1,175
   **[verified]**. We would be entering a niche the size of our own audience,
   against an incumbent with 14× our version count.
3. **A dependency-free JS BDI library already exists** — `js-son-agent`, 17
   versions, zero dependencies **[verified]**, covering the belief, desire,
   intention, plan, preference and belief-revision concepts the proposal's
   `AG-006`, `AG-007`, `AG-013`, `AG-014` and `AG-018` were built around.
4. **The parts we are good at are already shipped.** A proposal to add
   exponential-forgetting belief strength (`AG-008`) restated
   `src/utils/smallLfu.js`, whose own header already describes "exponential
   decay over a sliding window" as the W-TinyLFU half-life reset **[verified]**.

---

## 1. What was proposed

Thirty-five rows, prefixed `AG-001`…`AG-035`, grouped as: a measurement gate
(`AG-001`), a domain decision (`AG-002`), determinism substrate (`AG-003`–
`AG-005`), beliefs (`AG-006`–`AG-011`), desires (`AG-012`–`AG-013`),
intentions (`AG-014`–`AG-017`), the tick (`AG-018`), multiple agents
(`AG-019`–`AG-025`), meta-helpers (`AG-026`–`AG-029`), and five rejections
(`AG-030`–`AG-034`).

Its own §13 predicted the failure mode that actually occurred:

> The domain's attraction is mostly vocabulary. … The risk in adopting this
> domain is not building the wrong thing; it is building twenty correct small
> things that nobody asked for, and calling the collection an architecture.

That is what happened, and §2–§4 are the evidence.

---

## 2. Scope: this package does not do this

### The declared identity

`package.json` **[verified]**:

- **description**: `Performance toolbox`
- **keywords**: `node`, `javascript`, `performance`, `workers`, `cache`,
  `buffer`, `logger`, `pool`, `batch`, `eventbus`, `microtask`, `macrotask`,
  `scheduler`, `utilities`, `helpers`, `parallel`, `concurrency`, `throttle`,
  `debounce`, `memoize`, `lru`, `ttl`

Not one concerns agents, beliefs, planning, negotiation, protocols, protocols'
adjacent domains, or simulation. `guides/metaGuide.md` frames selection with
four questions **[verified]**: _What is the main failure mode or bottleneck?
What is the smallest helper that solves it? What else is it usually paired
with? What should I avoid?_ Every row in its quick chooser is a bottleneck —
"without one slow client stalling the rest", "without unbounded client-side
buffering". The organising question is cost. **[mechanism]** A belief store has
no cost story that a reader of this guide would recognise.

### The effort profile says the same thing

`review.md`'s 197 sized rows break down XS 84, S 71, M 33, L 9 — **79 % XS/S**
**[verified]**. The proposal was XS 3, S 14, M 11, L 7 — **49 % XS/S**, and
**7 `L` rows in 35** against **9 `L` rows in the repository's entire 205-row
history** **[verified]**. That is 4.5× the `L` density of the work this
repository has actually shipped, proposed in a document whose own first row
concedes the domain decision had not been made.

Size alone is not the objection: the median helper is 444 lines and the largest
is 4,314, so one `L` row is the median helper **[verified]**. Seven of them,
including an automata library, is a different portfolio.

### And the backlog

`review.md` carried **85 open rows against 111 shipped** when this sweep
started — a 3:4 ratio of open to done **[verified; read with
`npm run review:check`, which is the live source and prints the current
histogram]**. The proposal added 35, a **+41 %** increase in one sitting.
**[mechanism]** A plan whose open items already outnumber its shipped ones by
3:4 does not get 1.4× larger because a document was enthusiastic about a domain.
The row count has since moved on — another session closed `POOL-012` while this
document was written (§8) — which is the point: the backlog is a live number and
this paragraph is dated rather than quoted.

---

## 3. Market: the niche is the size of our own audience

npm registry, last 12 months **[verified]**:

| Package                                                   | Downloads/yr | Versions | Created    | Last activity | Deps |
| --------------------------------------------------------- | -----------: | -------: | ---------- | ------------- | ---: |
| `js-son-agent` — "A Minimal JavaScript BDI Agent Library" |    **1,319** |       17 | 2019-02-11 | 2024-06-30    |    0 |
| `flocc` — agent-based modelling, browser + Node           |        7,947 |       91 | 2018-04-25 | 2026-03-12    |    0 |
| `performance-helpers` — this package                      |    **1,175** |        4 | 2026-04-10 | 2026-07-13    |    0 |

Two readings, and the second is the one that matters:

1. The BDI niche is small. `js-son-agent` at 1,319/year is not a market we grow
   into by out-implementing a 0.0.x package — though note it is _alive_, with a
   2024 registry touch and zero dependencies, so "abandoned" is not the argument.
2. **The niche is 1.12× our own audience.** At 1,175 downloads/year from a
   three-month-old package — roughly 3.9/day — this repository's binding
   constraint looks like **discoverability of what already exists**, not the
   absence of a thirty-eighth helper. We ship 37 helpers and 41 guide files. The
   marginal guide is worth more than the marginal helper, and that ratio has
   never been measured either.

`flocc` is the useful contrast: agent-based modelling in JavaScript is **6.8×
our size** and actively maintained with 91 versions. So the ABM reading of
"agent base modelling" has a real incumbent that is _growing_, which is exactly
why the proposal's own `A-35` rejected building one. That judgement was right,
and it was right for the wrong reason — the right reason is 7,947 downloads a
year against our 1,175.

---

## 4. The research error: the library we did not look for

**The proposal's research searched academic terms and 2026 framework terms. It
never searched "BDI JavaScript library npm".** That query is the one that would
have withdrawn half the document before it was written, and it is the same class
of error `AGENTS.md` documents four times: scoping to a number nobody produced.

`js-son-agent` **[source, snippet — README, PyPI-adjacent thesis record and npm
registry; the library itself was not installed or run]** implements:

| Proposal row                                          | `js-son-agent` equivalent                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `AG-006` `PowerBelief` value type                     | `Belief(id, value, priority, updatePriority)`                                             |
| `AG-007` `PowerBeliefSet` derived beliefs, retraction | `FunctionalBelief(id, value, fn, priority)` — a belief inferred from old plus new beliefs |
| `AG-013` `PowerPreference`, Lex Prior                 | `revisePriority(oldBeliefs, newBeliefs)` and `Agent.determinePreferences`                 |
| `AG-014` `PowerCommitment` intention lifecycle        | `Intentions(beliefs, desires, preferenceFunctionGenerator)`                               |
| `AG-018` `PowerAgentLoop` perceive/update/act         | `Plan(head, body)` + `Environment` + `Agent` reasoning loop                               |

**[mechanism]** The proposal's §10 rejected "a BDI framework, or any object that
owns the agent" for duplicating helpers behind its own API — while §4 through
§9 proposed building one across 25 rows. The duplication test was applied
honestly to Flocc and to Jason, and not applied to the JavaScript equivalent of
Jason. A consistent application of the proposal's own rule rejects §§4–§9.

---

## 5. What the proposal got wrong about itself

Three failures, recorded because they generalise and because the second is the
kind this repository most wants written down.

### 5.1 The measurement supported the wrong claim

§11 of the proposal ran a real probe and produced sixteen rows of nanoseconds:
`PowerEventBus.emit` at 31 ns minimum, `PowerTTLMap.set`+`get` at 27 ns, a
composite tick at 37.7 ns, and one robust ratio — transcendental decay sweep
versus multiply-only evaporation at **9.9–10.7× per cell**, consistent across
two array sizes and both estimators **[hypothesis, measured, never given a
`bench/claims.js` mode]**.

Every one of those numbers measures an **existing** helper. The conclusion drawn
was "in an agent loop the events are free and the state is not" — which is true
of the plumbing and says nothing whatever about whether any _proposed_ helper is
worth building. **[mechanism]** A floor measurement was presented as premise
evidence for a feature list. The ratio was sound; the decision it informed
(`AG-009`, a pheromone field on a grid, for swarm robotics) was wrong, and it is
withdrawn in §7.

### 5.2 A proposed row restated shipped code

`AG-008` proposed "exponential-forgetting strength, lazy per read, shared
half-life" as new. `src/utils/smallLfu.js` already implements exponential decay
over a sliding window as the W-TinyLFU half-life reset, and says so in its own
module header: _"a half-life reset … exponential decay over a sliding window,
which is what the Caffeine/Ristretto implementations call `reset`"_
**[verified]**. The proposal cited the memory literature for the formula and did
not check whether the library already had the mechanism. **[mechanism]** A grep
for the mechanism's _name_ would have found it; a grep for its _paper_ would not.

### 5.3 The surviving rows were not checked against the backlog first

The review proposed filing four survivors. Grepping `review.md` before writing
them killed two:

| Proposed survivor                                                | What `review.md` already said                                                                                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AG-005` ordered typed replay cursor over the hub's retained log | `F-30`: "hub `retain` **does** replay; the subagent's central claim did not reproduce". `RT-034` ✅: "Make `retain` actually replay to a late subscriber". The capability ships and works; a cursor over it is speculative. |
| `AG-003` injectable logical clock                                | `RES-019` ⏰ already owns clock work; `RT-026` ⏰ already asks to "expose `bytesQueued` and the `now` clock, or delete both". An injectable clock is not a new row.                                                         |
| `AG-029` documented selection order                              | Three lines, and worthless until `FEAT-002` (task priorities) exists. Not a row.                                                                                                                                            |
| `AG-017` idempotency ledger                                      | **No row implements one**, though `ALGO-006` defers request hedging because it "needs an idempotency story". Filed as `POOL-013`.                                                                                           |
| `AG-004` expose the sketch seed                                  | No row covers it. Filed as `CACHE-020`.                                                                                                                                                                                     |

Four became two. **[mechanism]** A proposal that greps its own repository's
backlog before writing rows would have been a third the size on arrival.

---

## 6. Verified findings that survive

Three verified facts about shipped code. Two became rows; the third is a
constraint on future work.

1. **`PowerCache` does not pass the sketch's `seed`.** `SmallLfuSketch` accepts
   and documents `{ seed }` — _"per-cache seed, so two caches do not share a
   hash pattern. Random when omitted"_ **[verified, `src/utils/smallLfu.js:114`]**
   — but `src/helpers/powerCache.js:491` constructs it with `width` and
   `sampleSize` only, so `smallLfu.js:138` draws the seed from `Math.random()`.
   Two caches in one process therefore hash differently, and an
   admission-sensitive result is not attributable to a run. → **`CACHE-020`**.
2. **The retry path has no idempotency story, and one row already says so.**
   `ALGO-006` defers request hedging for exactly this reason **[verified]**.
   → **`POOL-013`**.
3. **`Math.random()` is called directly at six sites in `src/`** — `smallLfu.js`,
   `powerPool.js`, `powerWebSocketClient.js`, `powerRetry.js` (×2), `powerCron.js`,
   `powerCircuit.js` **[verified]**, and the only seeded generator in the
   repository is `makeRng(seed)` inside `bench/claims.js`. **[mechanism]** That
   is _defensible_ for jitter and reconnect backoff — reproducibility is not a
   property a retry delay should have — so this is a constraint, not a defect:
   any future claim that a helper's behaviour is reproducible must state which
   of those six sites it depends on. It is also why `CACHE-020` is worth an XS:
   the sketch is the one site where non-determinism changes a _result_ rather
   than a delay.

---

## 7. Measurements taken, and withdrawn

The probe ran; the numbers are recorded here because `AGENTS.md` treats a
withdrawn claim as worth keeping — it is why the next proposal does not repeat
the work. **[hypothesis] — no `bench/claims.js` mode exists for any of it.**

| Measurement                                             | Value (minimum of 5 runs) | Status                                    |
| ------------------------------------------------------- | ------------------------: | ----------------------------------------- |
| `PowerEventBus.emit` to one listener                    |                   31.0 ns | withdrawn — describes existing code       |
| `PowerTTLMap.set`+`get`, 1 key                          |                   26.8 ns | withdrawn — describes existing code       |
| `PowerCache.set`+`get`, LRU, 1024 keys                  |                  295.3 ns | withdrawn — describes existing code       |
| `PowerCache.set`+`get`, TinyLFU, 1024 keys              |                  678.1 ns | withdrawn — describes existing code       |
| `PowerRealtimeHub.publish`, `batch:false`               |                   53.0 ns | **unusable** — 397 % min/max spread       |
| `PowerRealtimeHub.publish`, `retain:true`               |                  120.9 ns | withdrawn — 57.9 % spread                 |
| `PowerScheduler.schedule`                               |                    7.8 ns | withdrawn — describes existing code       |
| `PowerServo.step`                                       |                    9.5 ns | withdrawn — describes existing code       |
| Composite tick: emit + TTLMap write + schedule          |                   37.7 ns | withdrawn — the "plumbing is free" claim  |
| Exponential decay sweep, 10 000 entries, per tick       |                   66.4 µs | **withdrawn with `AG-009`**               |
| Multiply-only evaporation sweep, 10 000 cells, per tick |                    4.6 µs | **withdrawn with `AG-009`**               |
| Ratio of the two sweeps                                 |             **9.9–10.7×** | sound measurement, **decision withdrawn** |

The ratio was the only figure robust enough to act on (consistent across two
sizes and both estimators, where everything else moved by up to 3× between two
runs of the same script on the same machine). It informed the design of
`AG-009`, a decaying grid for swarm-robotics routing, which §0 declines. **The
measurement stands; the decision it informed does not.** That is the honest
shape of it, and it is the same shape as `REJ-009`'s permit pool: measured at
6.4× _more_ expensive than the field read already in the path.

---

## 8. The two rows that moved to review.md

Both verified in place with the repository's own parser: `checkTable` reports
**0 problems** and `npm run review:check` reports **207 rows, all 8 columns**,
with `test/reviewTable.test.js` passing 8/8 and the rows present. Live
histograms are deliberately **not** quoted here — `review:check` prints them and
says "_§8 quotes these — if they differ, the prose is stale, not the table_", so
a static copy in a second document is a stale number waiting to happen.

**The edit was verified against a backup, and the verification caught a change
that was not mine.** Diffing `/tmp/kilo/review.md.bak` against `review.md`
immediately after the insertion showed exactly **2 additions and 0 deletions**,
which is what two inserted rows should look like. Diffing the same pair again
minutes later shows **3**: `POOL-012` was flipped `⬜` → `✅` by another session
working in the same tree, between my backup at 16:13 and the file's mtime at
16:18. The row's note is intact and it still validates, so whoever closed it used
`scripts/close-review-row.mjs` or made the edit correctly.

**[mechanism]** `review.md` is gitignored, untracked, shared working state, and
it is being edited while this document was being written. That is exactly the
hazard `AGENTS.md` records twice — `ac45b6f`, a commit carrying generated trees
for a source file that was not in the repository, and `e476642`, whose message
described unrelated audit work while the staged set held the feature. The
defence in both cases was the same one that worked here: **diff against the
backup, and re-diff before quoting a number.** Do not trust a diff you read
minutes ago, and do not "fix" a row change you did not make.

| Row         | Task                                                                                                           | Priority | Effort |
| ----------- | -------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| `CACHE-020` | Expose `SmallLfuSketch`'s existing `seed` option through `PowerCache`, so admission decisions are reproducible | **P1**   | XS     |
| `POOL-013`  | An idempotency-key ledger on the message path, so a retried or re-posted task is applied once                  | **P1**   | M      |

`CACHE-020` is the better of the two and the only row in this document that
would have been worth writing on its own merits: one option, no algorithm
change, no hot-path cost, and it makes `bench/` figures attributable to a named
seed rather than to process start order. Its test is a property, not a value —
two caches with the same seed must produce identical admission decisions on a
fixed key stream — and the mutant that drops `seed` must fail it.

`POOL-013` is `M` rather than `S` because the design decision worth writing down
is **in-flight versus settled**: a key marked before the work and settled after,
so a concurrent duplicate is distinguishable from a retry. It is opt-in, and the
counter to assert is lookups per post, zero when off.

---

## 9. Preconditions for revisiting

Not "if the domain comes back" — under what specific, checkable conditions it
would be worth re-reading. None of the three is code.

1. **A named consumer who is not this repository's existing audience.** A real
   user, not a hypothetical, who needs a dependency-free agent primitive and
   would otherwise ship a dependency.
2. **A download trajectory above ~1,300/year** — the size of the entire
   incumbent niche — **or** a second package with a real audience behind it. The
   arithmetic in §3 does not improve by waiting.
3. **One row, not thirty-five, with a failing test attached before the second is
   written.** The proposal's own `AG-002` said this and was then ignored by the
   document it gated.

If all three hold, the honest entry point is the one row the review could not
kill: `AG-026`, a runtime monitor over the event stream with three-valued
verdicts. It is the only proposal row describing a **capability** the library
lacks outright, rather than a re-skin of something it has. **[source, snippet]**
Its algorithm is 2005-era three-valued LTL monitoring (`LTL₃`) and exists in
`telo` (Rust), `@fast-check/LTL` (TypeScript, test-oriented, 2024) and
`LamaConv` (Java, which builds `LTL₃` Moore monitors) — so it would be a
**port**, not an invention, and it would need automata construction,
determinisation and minimisation, which nothing in 25,378 lines of this
repository's history suggests we have done. **Out of our depth** is the honest
verdict, and it is the reason this stays in §9 rather than becoming a row.

---

## 10. Dropped rows, recorded

Listed so they are not re-proposed. `AG-nnn` ids are from the withdrawn table.

| Row      | What it was                                              | Why not                                                                                   |
| -------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `AG-001` | Promote the tick probe to a `bench/claims.js agent` mode | Measures nothing we would keep: §7                                                        |
| `AG-002` | Decide whether this library takes the domain             | This document, §0                                                                         |
| `AG-003` | Seeded RNG and injectable clock                          | `RES-019`, `RT-026` own it; §5.3                                                          |
| `AG-005` | Ordered typed replay cursor                              | `RT-034` ✅ and `F-30`: replay ships                                                      |
| `AG-006` | `PowerBelief` value type                                 | `js-son-agent`'s `Belief`; §4                                                             |
| `AG-007` | `PowerBeliefSet` justifications, retraction              | `FunctionalBelief`; and belief revision is logic we have not written here                 |
| `AG-008` | Exponential-forgetting strength                          | Already shipped as the TinyLFU half-life reset; §5.2                                      |
| `AG-009` | `PowerPheromone` evaporating counter field               | Needs a spatial model this library has none of, and it is swarm robotics                  |
| `AG-010` | Cold belief store over `PowerCache`                      | `PowerCache` _is_ the hot half; re-proposes the cache                                     |
| `AG-011` | ATMS label sets                                          | Worst case exponential, by the reference treatment's own account                          |
| `AG-012` | `PowerUtility` constrained scoring                       | Generic application code; no performance content                                          |
| `AG-013` | `PowerPreference` lexicographic resolution               | `revisePriority`; §4                                                                      |
| `AG-014` | `PowerCommitment` six-state machine                      | `Intentions` + `determinePreferences`; §4                                                 |
| `AG-015` | Reconsideration hook                                     | Needs `AG-014`; commitment protocol is out of depth                                       |
| `AG-016` | Intention preemption order                               | Needs `FEAT-002`; three lines                                                             |
| `AG-018` | `PowerAgentLoop` with step ceiling                       | The ceiling is in scope and cheap; the loop is not, and `js-son-agent` has the loop       |
| `AG-019` | `PowerDirectory` capability descriptors                  | A protocol layer; this repository has never shipped a protocol and sells measured cost    |
| `AG-020` | `PowerCNet` contract-net state machine                   | Same, and FIPA conformance was never the goal                                             |
| `AG-021` | `PowerAuction`                                           | Pays only on heterogeneous bids; game theory                                              |
| `AG-022` | `PowerBargain` one-shot split                            | Forty lines anyone can write; backward induction                                          |
| `AG-023` | `PowerReputation` beta-PDF                               | Assumes stable identities this library explicitly does not have                           |
| `AG-024` | `PowerTaskAlloc` optimal assignment                      | Cubic; crossover unmeasured; combinatorial optimisation                                   |
| `AG-025` | MAPF reservation table                                   | Robotics; spatial model; the proposal's own `A-29` recommended rejection                  |
| `AG-026` | LTL runtime monitor                                      | The one real gap; out of our depth. §9                                                    |
| `AG-027` | Justification graph over `TraceContext`                  | Needs `AG-006` and `AG-007`; both declined                                                |
| `AG-028` | Budget and admission policy                              | `PowerServo`, `PowerThrottle` and `PowerBulkhead` ship; this was a guide, not a helper    |
| `AG-029` | Documented agent-selection order                         | Needs `FEAT-002`; §5.3                                                                    |
| `AG-030` | PDL / ASPIC+ reasoner                                    | A theorem prover's job; `REJ-008`                                                         |
| `AG-031` | JavaScript ABM framework                                 | `flocc`, 91 versions, maintained, zero deps; §3                                           |
| `AG-032` | Cross-process or cross-tab shared agent state            | Re-affirms `GAP-015` and the `BC-*` rows                                                  |
| `AG-033` | Multi-agent consensus                                    | Each agent is a worker in one pool; this is a work-queue problem, and `PowerQueue` is one |
| `AG-034` | HTN/PDDL, vector memory, schema validation               | Each needs a dependency; `REJ-008` is a product decision, twice                           |

---

## 11. If you are reading this to decide whether to revisit

Three sentences. The proposal was competently researched and badly scoped: the
mechanism analysis was mostly right — the BDI cycle really does decompose into
`PowerEventBus`, `PowerObserver`, `PowerDefer`, `PowerPool` and
`PowerScheduler`, and the end-of-cycle flush really is Rao & Georgeff's
`post-intention-status` — and that is exactly why it failed. **A proposal whose
stages are all existing helpers is a naming exercise**, and this repository's
product identity is that its helpers are individually worth having. When the
analysis is that good and the conclusion is still "add 25 rows", the analysis is
telling you the conclusion is wrong.

The two rows that survived had nothing to do with agents. They came from a
question that had nothing to do with agents. That is the transferable lesson,
and it is the same one `AGENTS.md` records from four projects' worth of
premises that were never measured.

---

_No code changed. `review.md` gained two rows and lost nothing: 205 → 207,
`checkTable` 0 problems, `test/reviewTable.test.js` 8/8. The 33-row proposal is
withdrawn, and the npm figures in §3 and the registry facts in §4 are
re-checkable against `https://api.npmjs.org/downloads/point/last-year/<pkg>`._
