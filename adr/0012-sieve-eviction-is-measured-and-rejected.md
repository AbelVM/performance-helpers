# 0011. SIEVE eviction is measured and rejected

**Status:** Rejected
**Affects:** `PowerCache` (`src/helpers/cache/core.js`) — the eviction policy's value set, which does **not** gain a `sieve` option
**Evidence:** `node bench/claims.js sieve`, run 2026-10-09. The mode already existed; this ADR records what it said rather than adding a benchmark.

## Context

S1a asked for SIEVE as an alternative eviction policy, noting that
`bench/claims.js` already had a `sieve` mode and that the fit with the current
API needed evaluating. The row's own framing — "evaluate fit with current API
(admission/eviction). May require new option" — is the right one, and the
evaluation is the whole of the work.

SIEVE's appeal is that a hit costs one bit store where LRU costs three pointer
writes. That is a real structural advantage, and it is the reason the mode was
written in the first place.

## Measurement

`node bench/claims.js sieve`, scan-heavy workload (25 one-shot per 900 hot),
configured `maxEntries` of 500:

| policy                     |  hit rate |  hot hits |    ns/op |
| -------------------------- | --------: | --------: | -------: |
| shipped: lru               |     51.0% |     52.4% |     3678 |
| shipped: lru + tinylfu w=4 |     49.2% |     50.5% |     7284 |
| bench: plain LRU (control) |     51.0% |     52.4% |      723 |
| **bench: SIEVE**           | **51.1%** | **52.5%** | **1212** |

- **vs the plain-LRU control: +0.2 points.** SIEVE's hit rate is the control's
  hit rate. On this trace the lazy-deletion structure buys nothing.
- **vs the shipped `lru + tinylfu w=4`: +2.0 points.** Two points is the entire
  case for the feature.
- **Cost: 1212 ns/op against the control's 723.** SIEVE is **68% slower per
  operation** than the plain LRU it was supposed to beat on cost.

The bench's own conclusion is the accurate one: "The hit is one bit store
against three pointer writes, and it is not faster here."

## Decision

**Do not add a `sieve` eviction policy.** The premise was that a cheaper hit
would pay for itself. It does not: the hit is not cheaper in this
implementation, and the hit-rate gain over the shipped policy is two points.

This is the fourth item in this project's history to be scoped to a number
nobody had produced, and it is the fourth to be wrong. The pattern is worth
naming because it keeps recurring: a structurally appealing change, a plausible
mechanism, and no measurement until after the design is settled. The mode
existed in `bench/claims.js` before this row was written, which means the
number was available the whole time.

## What survives

Nothing in the implementation. The structural observation is worth keeping on
file and is already recorded: no cursor and no node pool makes CACHE-001
structurally impossible rather than merely unreachable-by-inspection. CACHE-001
is closed as not reproducible, so the claim is real and the bug it would
prevent does not exist.

## Not measured

- SIEVE under a **write-heavy** trace. The mode's workloads are read-dominated
  by construction, and SIEVE's advantage is on the eviction path, which a
  write-heavy trace would exercise far more. If a future row revisits this, that
  is the workload to add first — and until it exists, this ADR's conclusion is
  scoped to the traces it actually measured.
- SIEVE combined with the TinyLFU admission filter rather than against it. The
  comparison here is SIEVE alone against LRU alone and against the shipped
  composite.
