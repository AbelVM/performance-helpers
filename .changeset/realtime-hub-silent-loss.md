---
'performance-helpers': minor
---

Three defects in `PowerRealtimeHub`, all with the same signature: a message that
never arrived, and no counter that said so.

**`flush()` permanently wedged a hub configured with `batchDelayMs > 0`**

`flush()` cleared `_flushTimer` but not `_flushScheduled`, and the timer callback
was the only other place that reset that flag — so clearing the timer removed the
one thing that would have. Every later `publish` then short-circuited at
`_scheduleFlush`, and the hub stopped flushing for the life of the object.

Measured: publish, `flush()`, publish again, wait 100 ms — **0 frames sent**, 1
still queued. What made it worth a P0 rather than a missed frame is the counters:
`published` kept climbing, so a dashboard showed a live publisher, `delivered`
froze, and **`dropped` never moved** — because the slow-consumer policy only runs
in `_enqueue` and the message never reached a full queue. It reached a dead
scheduler. Both counters this library's own guide tells you to alert on reported
nothing wrong.

The trigger is any `flush()` before a later `publish`, so tests and any
timer-driven caller hit it. `batchDelayMs: 0` was never affected — it takes the
`queueMicrotask` branch, whose callback *does* reset the flag — and neither was
`batch: false`, which never sets it. All three are now pinned.

**`codec: 'raw'` silently discarded every message in a batch of two or more**

`_flushSubscriber` splices the batch off the subscriber's queue *before*
`_encodeBatch` runs, and `raw` cannot frame a batch boundary, so the throw
discarded everything it had taken. Two `publish` calls in one microtask is the
**default** `batch: true` path, so this was the normal case: measured
`published: 2, delivered: 0, dropped: 0` — no counter moved, for two messages the
caller published and the transport never saw.

A subscriber that could coalesce more than one is now rejected at `subscribe()`,
naming the option to change. The check is there rather than in the constructor
because `maxBatch` is a per-subscriber option and the hub's default is 32:
`raw` is legal, `maxBatch: 1` is the configuration the hub can honour, and
`subscribe()` is the only place both facts are visible. Note that `batch: false`
does **not** rescue the default, since the splice is unconditional.

A payload that cannot be framed at all is now counted in `dropped` and reported
through `onError`. Re-queuing it instead was the obvious fix and is wrong — an
encode failure is permanent, so the retry spins and `flush()` never resolves.

**`retain` never replayed, and publishing to an empty topic retained nothing**

`publish(topic, msg, { retain: true })` wrote to an internal map that nothing ever
read: it was consulted in exactly two places, its own write path and the detach
path. A subscriber arriving after a retained publish got `[]`, while the option is
documented as "keep the message for a subscriber that subscribes later". The
existing test could not catch it — it asserts `seen.length <= 32` on a value that
is structurally always `0`.

Worse, `_retain` sat *below* the `if (no subscribers) return 0` early return, so
publishing into a topic nobody was listening to retained nothing at all — which is
precisely the case the option exists for. Both are fixed; a replay goes through
the same queue and the same slow-consumer policy as a live delivery, and does not
increment `published`, because it is not a publication.

Separately, detaching one subscriber emptied the retained log for the **whole
topic**, so one subscriber leaving destroyed history every other live subscriber
on that topic still depended on. The log is per topic and the detach is per
subscriber; it is now released only when the last subscriber on that topic leaves,
with `close()` clearing the rest.