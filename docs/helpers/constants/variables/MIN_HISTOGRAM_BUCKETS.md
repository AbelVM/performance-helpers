[**performance-helpers**](../../../README.md)

---

[performance-helpers](../../../README.md) / [helpers/constants](../README.md) / MIN\_HISTOGRAM\_BUCKETS

# Variable: MIN\_HISTOGRAM\_BUCKETS

> `const` **MIN\_HISTOGRAM\_BUCKETS**: `4` = `4`

Floor on a `PowerHistogram`'s bucket count.

Fewer than 4 buckets makes the log-bucket ladder degenerate - the space
between the first and second boundary swallows most of the value range, so the
reported percentiles lose all resolution exactly where a small bucket count
seemed like a saving. Rounding up to 4 costs a handful of counters and keeps
the ladder meaningful.
