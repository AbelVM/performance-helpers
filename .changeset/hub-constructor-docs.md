---
'performance-helpers': patch
---

docs(realtime): document `PowerRealtimeHub`'s constructor options, and fix a guard that was not checking them

The hub's guide documented the per-call `subscribe()` options but never its
constructor options — eight of them, including `send`, which is required. There
was nothing to check against, so `npm run docs:claims` reported the guide as
"no options table; option names not checked" and passed.

Two fixes, and the second is the one that matters:

- The guide now carries a constructor options table, so seven names are checked.
- **`docs:claims` was not resolving options for this class at all**, and said
  nothing. Its parser matched `options?: SomeOptions` — the _optional_ form —
  while `PowerRealtimeHub`'s constructor is `constructor(options: HubOptions)`,
  required. No match meant no options resolved, which the script reported as a
  benign "no options typedef found" note rather than a gap.

A required options parameter lists exactly the same accepted names as an optional
one, so the pattern now accepts both. This is the fourth time a guard in this
project has passed while checking nothing, and the reason is recorded in the
script: a miss that reports itself as "nothing to see" is indistinguishable from a
guide that genuinely has no options.

Mutation-checked: renaming `batchDelayMs` to `batchDelay` in the new table fails
the guard, naming that option alone rather than all seven.
