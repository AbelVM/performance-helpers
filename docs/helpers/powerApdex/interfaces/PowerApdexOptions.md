[**performance-helpers**](../../../README.md)

***

[performance-helpers](../../../README.md) / [helpers/powerApdex](../README.md) / PowerApdexOptions

# Interface: PowerApdexOptions

## Properties

### observability?

> `optional` **observability?**: `boolean` \| [`MetricsCollector`](../../metrics/classes/MetricsCollector.md)

Opt in to metrics. See `guides/metrics.md`.

***

### target

> **target**: `number`

The SLO in the same unit `record()` takes
  (milliseconds by convention). Required: there is no default, because a
  guessed threshold would score against the wrong line and still look like a
  real number.

***

### tolerance?

> `optional` **tolerance?**: `number`

The upper bound of the tolerating
  class. Must be `>= target`; a smaller value would make the tolerating class
  empty and the arithmetic negative.
