# Architecture decision records

Design history, as opposed to reference. The guides under `guides/` answer
_how do I use this_; these answer _why is it like this_, which is the question
you have when a decision looks arbitrary and you need to know whether it is
load-bearing or accidental.

## Why these are not in `guides/`

The guides are the user-facing contract. Everything in them is something a
caller can depend on, and everything in them is maintained against the published
API. A design-history document is the opposite: it records reasoning that
existed _at a point in time_, some of which may since have been superseded, and
a reader who takes it as current guidance will be misled.

`docs/` was considered and rejected: it is generated typedoc output (DEAD-003),
and a hand-written file placed there is a file the next `npm run docs` will
either delete or overwrite. A dedicated directory at the repository root is the
only location that is neither generated nor published — `adr/` is deliberately
not in `package.json`'s `files`, because none of this should reach an
installing user.

## What belongs here

- A decision that constrains future work, and whose _reasoning_ someone will
  otherwise have to rediscover.
- A decision that looks wrong until you know why.
- A performance choice where the obvious alternative was measured and lost.

What does not: usage instructions, API reference, or anything already stated
plainly in a guide. If a reader needs it at the call site, it goes in
`guides/`.

## Index

| #                                                         | Decision                                                               | Status   |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | -------- |
| [0001](./0001-versioned-envelope-protocol.md)             | The pool frames every message in a versioned binary envelope           | Accepted |
| [0002](./0002-ring-buffer-queue.md)                       | `PowerQueue` is a hand-rolled ring buffer, not an array                | Accepted |
| [0003](./0003-tinylfu-admission-window.md)                | A frequency admission filter does not earn its keep on this workload   | Rejected |
| [0004](./0004-permit-capacity-ceiling-or-pool.md)         | `capacity` is a ceiling on some gates and a pool size on others        | Accepted |
| [0005](./0005-feedback-signal-picks-the-controller.md)    | A loop's signal picks the controller, not the other way round          | Accepted |
| [0006](./0006-sequence-in-the-envelope-not-the-header.md) | A resume sequence rides in the envelope, not the frame header          | Proposed |
| [0007](./0007-object-keys-in-the-admission-filter.md)     | What an object key means to the admission filter                       | Accepted |
| [0008](./0008-throw-or-false-for-an-unsendable-frame.md)  | `send()` throws for a permanent refusal, returns `false` for transient | Accepted |
| [0009](./0009-which-clock-a-helper-subtracts.md)          | Which clock a helper subtracts                                         | Accepted |

## Status values

`Proposed` · `Accepted` · `Superseded by [NNNN]` · `Rejected`

A rejected decision is still worth recording. A reader who proposes the same
thing next year should find the measurement that killed it rather than repeat
the work — which is what happened twice in this project's own history, and is
why `review.md` keeps `PERF-006` and `BENCH-002` rather than closing them.

## There is one of these directories, not two

An earlier layout had both `adr/` and `design/`, with `design/` holding a single
32 KB working note about one abandoned cache mechanism. It was a duplicate genre
with a one-file directory: a reader opening either to ask "why is this like
this?" had no way to know which held the answer, and the answer could turn out to
be in neither.

Everything of durable value in that note became **0003**, with the
implementation history kept as its appendix. A rejected decision with a
measurement attached is the strongest thing this directory can contain, and the
note it replaced was neither a decision nor short.

So: decision history lives here, and working notes do not get their own
directory at the root. If a piece of design history is worth keeping, it is
either a decision (an ADR, shaped as one, with a status) or it belongs in a
guide — and the test is whether a reader would act differently after reading it.
