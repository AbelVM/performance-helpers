---
'performance-helpers': major
---

BREAKING: an unknown constructor option now throws instead of being ignored

Every helper silently ignored unrecognised option keys. This change makes that an
error, naming the option, the class, and — where there is an obvious near miss —
what was probably meant:

    new PowerThrottle({ capacity: 10, refillRat: 5 })
    // TypeError: PowerThrottle: unknown option `refillRat`.
    //   Did you mean `refillRate`? Accepted options: capacity, now, refillRate, tokens.

The error carries `code: 'ERR_UNKNOWN_OPTION'` and `option: '<key>'`, so a caller
need not parse the message.

Why this is the right trade

The old tolerance was introduced in 9a1f9d5, when four inert options were removed,
with sound reasoning: a caller already passing a removed option could not have
been depending on behaviour that never existed, so ignoring the key cost nothing.
That reasoning is correct for a **removed** option and does not cover a
**misspelled** one, which is the common case and the one that reaches production:

    new PowerThrottle({ capacity: 10, refillRat: 5 })

builds a bucket that never refills. Nothing is thrown, nothing is warned, and the
limiter is indistinguishable from a correct one until a request is refused in
production.

What it cost, measured

Turning the check on for a commit found **nine tests across six classes** passing
options that do not exist. Every one of those tests passed, and every one was
asserting nothing — the helper behaved exactly as it would have with the option
absent. Three passed _both_ the real option and a misspelling of it:

    new PowerThrottle({ capacity: 10, windowMs: 1000, capacity: 10 })

where `windowMs` is a `PowerSlidingWindow` option. Read as intent that is
ambiguous — was the test exercising a window, or a throttle with a redundant
capacity? — and that ambiguity, not the typo, is the real damage.

The same defect had reached a guide: `guides/powerThrottle.md` documented
`refillInterval`, removed in `9a1d9d5` because it was inert, as a live option with
a default, while the generated types correctly omitted it. And two shipped
examples set options that never existed — `maxWaitMs` on `PowerBatch` and
`refillInterval` on `PowerThrottle`.

## Migrating

If you pass an option that no longer exists, the error names the class and the
key. Either remove it, or — if it genuinely crosses a version boundary — strip it
before constructing:

    new PowerThrottle({ capacity: 10, ...pickKnown(opts, 'refillRate') })

Falsy values are unaffected: `observability: false` still means "off", and a
class with no options object still constructs as before.

## Scope

30 classes. The accepted set is derived from each class's published typedef, so a
constructor and its `types/` declaration now agree by construction rather than by
inspection — which is the property whose absence let the drifted spellings above
through in the first place.

Two of them accept keys that belong to a collaborator rather than to them:
`PowerCache` also takes `keyResolver`, `cacheOptions`, `ttl` and `weight`, because
`PowerMemoizer` forwards its own options straight into the cache it owns.
