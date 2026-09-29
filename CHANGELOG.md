# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The 2.0 release is consolidated in
[`.changeset/release-2-0-0.md`](.changeset/release-2-0-0.md), which carries the
full description of every change in it. This file becomes the published history
when that version is cut; until then it is a pointer rather than a duplicate,
because a changelog that is maintained separately from the release notes is a
changelog that goes stale.

`changeset version` consumes the consolidated file at release time and the
section below is filled in from it.

## Why the changesets are consolidated

22 individual changesets had accumulated alongside one already-merged
`release-2-0-0.md`. Each was correct and each was about one commit; together
they read as a list of edits rather than as a release, and a reader of a
pre-release branch has no way to tell which of them they must actually read.

They are now one file, grouped by theme rather than by the adjective the
generator happened to pick — _Message protocol_, _Benchmarks and the timing
gate_, _Cache, chunking and guides_, _Fixes and smaller work_ — because a
filename like `olive-moons-count` carries no information a reader can act on.
The frontmatter is `major`, so 2.0.0 is what `changeset version` produces.

## What a reader should know about 2.0

Three things, each of which was a change of direction rather than an addition:

1. **The pool's message protocol changed, and it is versioned.** Messages are
   framed in an explicit `[version][codec][length][payload]` envelope rather than
   sniffed, so a worker reads `decodeMessage(e.data).value` instead of
   `u82o(e.data)`. `messageCodec: 'legacy'` restores the old framing for a worker
   that has not migrated. See [ADR 0001](adr/0001-versioned-envelope-protocol.md).

2. **The framed protocol is lossy, so a worker can negotiate a better one.**
   A `Map` arrives as `{}`, a `Date` as an ISO string, and a `BigInt` makes the
   message undecodable. `messageCodec: 'negotiated'` sends the native carrier to
   workers that advertise it and framed JSON to everyone else. **It is not a
   speedup** — a release note claiming 2–5× was withdrawn after measurement
   showed a structured clone is a tie for small objects and up to ~1.7× _slower_
   for deep structure. Fidelity is the reason. See
   [`guides/powerMessageCodec.md`](guides/powerMessageCodec.md).

3. **Two proposals were closed by measurement rather than built**, and both are
   recorded so the next person finds the numbers instead of repeating the work:
   a frequency admission filter for `PowerCache`
   ([ADR 0003](adr/0003-tinylfu-admission-window.md)) and compression on the
   pool message path. Both assumed a cost that a transport inside one process
   does not charge for.

## Reading a claim in this project

Every performance claim in the guides is reproducible from `bench/`, and several
are documented as **withdrawn** because the measurement contradicted them. That
is the intended state: a changelog that only contains claims that survived
measurement is indistinguishable from one written without measuring.

```
node bench/claims.js zipf        # cache admission policies
node bench/claims.js coldstart   # the cold-start case, which answers differently
node bench/claims.js carrier     # message-carrier fidelity and encode cost
node bench/claims.js payload     # why compression does not pay in-process
node bench/claims.js permit      # what a SharedArrayBuffer permit pool would cost
node bench/claims.js stream      # chunking against posting one message
npm run bench:gate               # per-machine regression gate
```

## [1.0.3] - released

The 1.x line. `docs/` and the [changelog on GitHub](https://github.com/AbelVM/performance-helpers/releases)
carry the detail for those versions; this file covers 2.0 onward.

[Unreleased]: https://github.com/AbelVM/performance-helpers/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/AbelVM/performance-helpers/releases/tag/v1.0.3
