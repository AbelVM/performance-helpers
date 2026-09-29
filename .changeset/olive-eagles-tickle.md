---
'performance-helpers': patch
---

Documents what the `drop-oldest` queue policy actually does.

`guides/powerPool.md` said the policy "evicts one and admits one, so the queue
holds a steady number" without saying which number. It is one: the pool evicts
whenever the queue is non-empty, not only when the queue is at the cap, so
`maxQueueLength` does not raise it. A reader who set `maxQueueLength: 100` with
`queuePolicy: 'drop-oldest'` and observed a queue of length 1 had no way to tell
whether that was intended.

The behaviour is unchanged and was already deliberate — BUG-016 found the
self-bounding and accepted it, and it is what keeps this policy from refusing
work the way `'enqueue'` does at the cap. The guide now states the number, and
says what to use instead if you want a bounded backlog that fills before it
starts dropping.
