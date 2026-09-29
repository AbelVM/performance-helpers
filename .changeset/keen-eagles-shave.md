---
'performance-helpers': patch
---

Fixes every link in the documentation site's navigation, and adds two design
decision records.

`assets/navigation.md` is the VuePress navigation page, and every one of its
links was written relative to the repository root while the file itself lives
in `assets/` — so none of them resolved. The review had recorded exactly one of
them as broken on the assumption that only that one was wrong; there were
eleven.

The tell was that the neighbouring pages got it right: `assets/1_Caching.md`
links with `../guides/powerCache.md`. One directory, two conventions.

All links are fixed, and `test/docsLinks.test.js` now checks every relative
markdown link in the repository (53 files) against the file that contains it,
failing with the offending path rather than a count. It reports the specific
mistake:

```
"LICENSE.md (resolves from the repo root, not from assets/navigation.md)"
```

The existing assertion in `test/index.test.js` that navigation reaches each
index had to change: it matched the _literal string_ `assets/1_Caching.md`,
which is the broken form. A working link from inside `assets/` reads
`1_Caching.md`, so the test was passing on the exact bug it appeared to guard.

Also adds `adr/`, two architecture decision records:

- **0001** — why every pool message crosses the wire in a
  `[version][codec][length][payload]` envelope rather than NDJSON or bare
  structured clone.
- **0002** — why `PowerQueue` is a power-of-two ring buffer with bitmask
  indexing, including the measurement that killed the proposed
  `toArray()`-based "optimisation" in `PERF-006` (563 µs against 14.8 ns).

These live at the repository root rather than in `guides/` because a decision
record is the reasoning as it stood at a point in time, and reading one as
current guidance misleads. They are not in `package.json`'s `files`, so none of
it reaches an installing user.

Documentation only. No API change.
