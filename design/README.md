# Design notes

Hand-written design-history documents: **why a thing is the way it is**, and
what was tried and rejected on the way.

## Why this directory exists

This repository has three kinds of documentation, and they were being confused
for one another:

| Location  | Kind                                           | Written by | Audience                       |
| --------- | ---------------------------------------------- | ---------- | ------------------------------ |
| `guides/` | Reference — what the API is and how to call it | humans     | someone using the library      |
| `docs/`   | Generated API reference                        | `typedoc`  | someone looking up a signature |
| `design/` | Decision history — why, and what did not work  | humans     | someone changing the library   |

`docs/` is generated and committed, so it is the wrong home for a hand-written
argument: the next `npm run docs` would bury or delete it. `guides/` is
reference material, and a design note is not that — a reader who opens
`guides/powerCache.md` wants to know how to call the thing, not why a
comparison operator was rejected. Keeping the two apart is what stops a
reference doc from accumulating stale justifications, and a design note from
being read as a promise about current behaviour.

**The audience decision these notes assume:** they are for a maintainer, and
they are expected to disagree. A note that only records what was decided is a
changelog; the value is in the rejected options and the measurements behind
them, because those are what stop the next person re-running the experiment.

## Notes

| Note                                                                  | Status                                    | Subject                                                       |
| --------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| [0001 — W-TinyLFU admission window](0001-tinylfu-admission-window.md) | **Proposed** — blocked on the size choice | Fixing the confirmed `admission: 'tinylfu'` cold-start defect |

## Still owed

`review.md`'s DOC-001 also calls for two design-history documents, and this
directory is where they should land:

- **The pool protocol envelope** — why `PowerPool` speaks a framed
  `[version][codec][length][payload]` message by default since 2.0 rather than
  the structured-clone objects it used before, and what the compatibility story
  is for a worker written against the old shape. The answer is already
  implemented and tested; what is missing is the record of why.
- **The hand-rolled ring buffer** — the `PowerQueue`/`PowerSlidingWindow`
  internals, which use a `POWER_QUEUE_INITIAL_CAPACITY` hint and a doubling
  strategy rather than a published data structure. The note should say what
  that buys, and when to replace it with a real one.

Neither is urgent, and both are the kind of thing that gets written badly by
someone in a hurry. They are listed so they are not forgotten.
