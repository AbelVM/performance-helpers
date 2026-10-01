---
'performance-helpers': patch
---

An ergonomics audit of the helpers, found by probing the built surface rather than
by reading it: an error that named the wrong class, a method that silently dropped
its arguments, a guide documenting an option that no longer exists, and a `stats()`
split that had reached the documentation as a false claim.

**Behaviour**

- **`PowerSemaphore.run(fn, options)` honours `options`.** It took no second
  parameter, so the `{ signal }` a caller writes by mirroring `acquire(options)` —
  which this class does accept — was silently discarded. It was discarded
  _quietly_: the promise stayed pending until a permit happened to be released, so
  an uncancellable request was indistinguishable from a slow one. With an
  already-aborted signal against a saturated semaphore, it never settled at all.
  `run` is the form people reach for first, so cancellation matters more here than
  on `acquire`, and `PowerBulkhead.run`, `PowerDeadline.run` and `PowerRetry.run`
  all accepted options already.

- **`PowerSemaphore`'s validation errors name itself and its own option.** It
  delegates its whole body to `new PowerPermitGate({ capacity: limit })`, and the
  gate's `className` was hardcoded, so every error told a caller who had written
  `new PowerSemaphore(...)` to look at a class they never constructed and an
  option they never typed:

  ```text
  before: PowerPermitGate: `capacity` must be a finite number
  after:  PowerSemaphore:   `limit` must be a finite number
  ```

  `PowerPermitGate` reports itself unchanged, and `queueCapacity` / `initialTokens`
  keep the gate's names on purpose — `PowerSemaphore` exposes neither, so pointing
  a caller at them would invent options. **If you match on the error text of a
  `PowerSemaphore` construction failure, update the pattern.**

**Additive**

- **`getStats()` on every helper that reports through `stats()`.** Nine helpers
  spelled it `stats()` and one — `PowerPool` — spelled it `getStats()`, with no
  stated rule and nothing pinning it. A user who learned one reached for the other
  name everywhere else and got `TypeError: x.getStats is not a function` from
  whichever class they had not learned the exception to. `getStats()` now
  delegates to `stats()` on all ten. `PowerPool` is unchanged — it is the older
  and far larger surface, and renaming it would be breaking.

  Two reversals are worth recording, because both shipped green first.

  **The first implementation was a dynamic prototype patch.** A
  `src/utils/statsAlias.js` applied `Object.defineProperty` at module scope. It
  worked at runtime and passed every runtime test, and was **absent from the
  published `types/`** — `tsc` cannot see a prototype patch — so a TypeScript
  caller would have got `Property 'getStats' does not exist` on a method that ran
  fine. That file no longer exists. The alias is now an ordinary method on each
  class, so `tsc` emits it like any other.

  **The second carried a hand-written copy of each `stats()` return shape.** The
  reasoning was that an explicit type was safer. It is not: a concurrent change
  added `staleServes` and `expirations` to `PowerCache.stats()` and the copies
  were stale within the same session. Omitting `@returns` lets `tsc` infer a
  byte-identical published type, and with nothing written twice there is nothing
  to keep in sync. The copies are gone.

  The type guarantee is now asserted where it belongs — `test/types.test-d.ts`
  compiles bidirectional assignments between `stats()` and `getStats()`, which is
  the property a consumer relies on. An earlier test compared the two _declaration
  strings_ and reported a false mismatch (`PowerRetryBudgetStats` versus
  `import("./jsdoc-types.js").PowerRetryBudgetStats` — the same type), which was
  itself arguing for putting the hand-written copies back.

  The alias is deliberately **not** added to classes with no `stats()` at all
  (`PowerTTLMap`, `PowerLogger`): it would hand a caller a `TypeError` from a name
  this change is teaching them to expect.

**Documentation**

- `guides/powerThrottle.md` documented `refillInterval` as a real option with a
  default of `1000`. The option was removed in 9a1d9d5 precisely because it was
  inert, and `types/` correctly omitted it — **only the guide still carried it**,
  so a user reading the guide set it, got silence in return, and landed on a
  limiter that behaved correctly by accident. Fixed there; the same stale name was
  in two of this repository's own tests, which passed only because unknown options
  are ignored and so were teaching an option name the API does not have.
- `guides/metrics.md` and `llm.txt` claimed that every helper reporting anything
  does it through its own `stats()`. Both were false about `PowerPool`, and
  `metrics.md` contradicted itself seven lines later by writing
  `metrics.register('pool', () => pool.getStats())`.

Closes QUAL-011.

**Known limits of this change, stated rather than left to be discovered:**

- Nothing here makes an **unknown option** an error. Every helper still ignores
  unrecognized keys, and `test/deadOptions.family.test.js` pins that as correct —
  sound reasoning for an option that was _removed_, since no caller could have been
  depending on behaviour that did not exist. It does not extend to a _misspelled_
  option, which is the common case: `new PowerThrottle({ refillRat: 5 })` yields a
  bucket that never refills. An opt-in `strictOptions` is the intended answer and
  is deliberately **not** in this release; the default is unchanged.
- Six constructors still take a positional primitive and throw on an options object
  (`PowerSemaphore`, `PowerQueue`, `PowerLatch`, `PowerLogger`, `PowerObserver`,
  and `PowerPermitGate` in its options-object form only), while about twenty take
  an options object. `PowerTTLMap` accepts both. Unifying the six is a 2.0 API
  decision rather than a patch, and is not attempted here.

**Per-call options are now typed.** Twelve methods used to publish
`options?: {}` — an empty object type-checks _anything_, so a TypeScript caller
passing `{ now: 1234 }` got no completion, no error, and no pointer to
`LimiterNowOptions`. The runtime has always forwarded and honoured these; only
the declaration was missing. They are now declared:

```ts
throttle.tryConsume(1, options?: LimiterNowOptions): boolean;
gate.acquire(options?: { signal?: AbortSignal }): Promise<PowerReleaseFn>;
timed.set(key, value, options?: { ttl?: number; weight?: number }): ...
```

This is worth spelling out because it **narrows** those twelve signatures in a
patch release: an options bag that used to accept anything now rejects unknown
keys. Code that was passing a misspelled key type-checked before and will not
now. That is the intended direction — a `PowerThrottle` whose `{ refillRat: 5 }`
was silently dropped is the bug — but it is a type-level tightening and is the
one part of this changeset that can break a compile that passed before.

Three things were needed to get there, none obvious:

- Each limiter needs an explicit
  `@typedef {import('../utils/limiterClock.js').LimiterNowOptions}` line. Without
  it `tsc` emits `.d.ts` files referencing an undefined name — the emitted
  declarations were wrong while the source looked correct.
- `test/types.test-d.ts` now carries `@ts-expect-error` directives proving an
  unknown key is _rejected_. Under `options?: {}` those directives would have
  compiled and then failed as unused, which is the only way to tell this fix from
  a decorative one.
- A runtime test pins that per-call `now` is honoured on a limiter constructed
  **with no injected clock**, which no existing test covered: every prior case went
  through an injected `now` or through the `PowerRateLimit` composition. Declaring
  an option is a promise it works, so it is pinned rather than assumed.

**Two options are now declared rather than left as `{}`.** `PowerPermitGate`'s
`className` and `limitName` are on `PowerPermitGateOptions`, which is what makes
the corrected error messages type-check at all — an undeclared property read
inside the constructor was 10 of the 14 type errors this change initially
introduced, and `npm run typecheck:ratchet` caught them at exactly the ceiling.
The ratchet did its job.
**A new gate step: `docs:claims` (step 9 of 10)**

Written because two defects in this repository shipped undetected, and neither
was caught by `docs:drift` — `docsCodeAgreement.test.js` and `docsLinks.test.js`
both check code _referenced from_ the docs, while these were a doc asserting
something about the code.

It found real drift immediately. Seven entries in `llm.txt` had prose sliced off
mid-sentence and a code fragment spliced onto the end — including
`import { PowerLatch } from '../src/helpers/powerLatch.js';` appended to a
summary. That is a generation bug in the one file whose entire purpose is
machine consumption, and it shipped. All seven are fixed.

Two corrections to documents that were actively wrong rather than merely stale:

- `llm.txt` claimed every line was "a title and that guide's own opening sentence
  … so the two can only disagree if the guide changes". Ten of its 49 entries are
  deliberate paraphrases, so the guarantee never held. It now describes what is
  actually true and what is actually checked.
- `guides/powerThrottle.md` documented `refillInterval` as a real option, removed
  in 9a1d9d5 because it was inert. `types/` correctly omitted it; only the guide
  carried it.

The check reads the **generated** declarations, so it runs after `types:generate`
and `types:drift`. Both halves are mutation-checked: re-injecting the
`refillInterval` row fails it, and re-injecting a code fragment into `llm.txt`
fails it.

Two limits stated rather than left to be found. It does not check option
_defaults_ — a default is not recorded in the published `.d.ts` at all, and
`refillInterval`'s wrong default was the more misleading half of that row. And
ten guides report "option names not checked" because they have no options typedef
in the declaration; that is reported honestly rather than counted as a pass.
