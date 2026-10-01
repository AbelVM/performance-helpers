---
'performance-helpers': patch
---

fix(metrics): a wrong `observability` value registered nothing and reported nothing

`attach()` in `src/helpers/metrics.js` read `options.observability`, treated any
truthy value as a request to be measured, then discarded anything that was not
`true` or a collector — silently.

    new PowerCache({ observability: 'yes' })

`'yes'` is truthy, is not `true`, and has no `register`, so it registered nothing
and raised nothing. A caller who asked to be measured was silently not measured,
and would find out from a dashboard that looked plausible. The option's type was
declared as `boolean | MetricsCollector` and never checked.

A bad value now throws, naming the class and what was passed. Falsy stays inert,
because "off" is a legitimate answer and `observability: false` is how you say it.

`test/metrics.test.js` had a test pinning the lenient behaviour — _"ignores a
value that is not a collector … A typo must be inert rather than fatal"_ — which
was the bug rather than the virtue. It is rewritten to assert the new contract,
with the reasoning kept, because the old reasoning is worth recording as the thing
that was wrong.
