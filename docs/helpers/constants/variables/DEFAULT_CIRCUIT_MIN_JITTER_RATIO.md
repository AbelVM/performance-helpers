[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / DEFAULT\_CIRCUIT\_MIN\_JITTER\_RATIO

# Variable: DEFAULT\_CIRCUIT\_MIN\_JITTER\_RATIO

> `const` **DEFAULT\_CIRCUIT\_MIN\_JITTER\_RATIO**: `0.5` = `0.5`

Floor on the jittered open window, as a fraction of the computed backoff.

This is **equal jitter** (the window is drawn uniformly from
`[delay / 2, delay]`), not AWS-style _full_ jitter (`[0, delay]`), and the
distinction matters for a circuit breaker specifically. Full jitter is right
for a retry delay, where the goal is to spread attempts. For a breaker's open
window the goal is different: the window has to be long enough to actually
stop the traffic. A full-jitter draw of a 30 s backoff can land near zero,
which re-opens the circuit almost immediately and turns the breaker into a
fast flapping no-op. Half-jitter still randomises — which is what breaks the
synchronised retry burst, since every client sharing a dependency would
otherwise probe it on the same tick — while guaranteeing the window never
collapses below half the computed backoff.
