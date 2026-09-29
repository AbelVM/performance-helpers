# Contributing

Thanks for contributing to `performance-helpers`.

This project is a small, performance-focused JavaScript toolbox for Node.js and browser runtimes. Contributions should stay consistent with that goal: small APIs, predictable behavior, low overhead, and clear documentation.

Repository: <https://github.com/AbelVM/performance-helpers>

## Prerequisites

- Node.js 22.12 or newer (matches `engines`; the code uses explicit resource
  management and relies on `require(esm)` for the CommonJS entry point)
- npm

Install dependencies:

```bash
npm install
```

## Project layout

- `src/helpers/`: helper implementations
- `src/utils/`: small shared utilities
- `test/`: Vitest coverage for helpers and edge cases
- `guides/`: user-facing helper guides
- `bench/`: benchmark runners and benchmark docs
- `types/`: generated declaration output

## Development workflow

1. Make the smallest change that solves the problem.
2. Keep public APIs stable unless the change explicitly requires API work.
3. Add or update tests for behavior changes.
4. Update the relevant guide or README entry when user-facing behavior changes.
5. Add a changeset for anything a consumer can observe (see [Releases](#releases)).
6. Run `npm run verify

# What CI runs. The coverage thresholds in vitest.config.js only apply under

# --coverage, so plain `npm test` does not enforce them; this substitution is the

# only difference between the two.

VERIFY_TEST=test:coverage npm run verify` before opening a PR.

## Useful commands

Run tests:

```bash
npm run test
```

Run linting:

```bash
npm run lint
```

Auto-fix lint issues:

```bash
npm run lint:fix
```

Format source and markdown:

```bash
npm run format
```

Generate declaration files:

```bash
npm run types:generate
```

Build the project:

```bash
npm run build
```

Generate docs:

```bash
npm run docs
```

Run benchmarks:

```bash
npm run bench
```

Run the full validation pipeline:

```bash
npm run build:full
```

Run the same gate that runs before every publish:

```bash
npm run verify
```

`verify` is `lint` + `test` + the type-debt ratchet + `build` + a check that the
built bundle exports what `src/` declares + a check that `types/` still matches
`src/`. It is what `prepublishOnly` calls, so `npm publish` and CI can never
disagree about what "green" means.

### Why the bundle check is not a test

`npm run check:bundle` compares the export names in `src/index.js` against the
built `dist/performance-helpers.cjs`. It is a `scripts/` step rather than a case
in the suite for a reason worth knowing before you try to "fix" it by moving it
back: `test/globalSetup.js` deletes and rebuilds `dist/` before every run, from
the same `src/` a test would import. So **inside a test run the bundle and the
source cannot diverge**, and a parity assertion there passes no matter what you
do to either side — three attempts at one were written and discarded before this
was the accepted reason.

The check also catches a bundle _older than its sources_, which is the failure
that actually reaches users: `dist/` is not committed, so a stale bundle
survives locally and every UMD test then asserts against yesterday's code.
`npm publish` runs `verify`, so that cannot ship.

## Type checking and type debt

Two TypeScript projects exist, and both are wired into the release gate:

| Command                     | What it checks                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`         | `tsconfig.check.json` - the JSDoc in `src/`, with `checkJs` on. Internal quality.                                                                                                             |
| `npm run test:types`        | `tsconfig.types.json` - the generated `types/*.d.ts` compiled the way a downstream TypeScript consumer would compile them, with no `@types/node`.                                             |
| `npm run typecheck:ratchet` | Both of the above, as a gate on the **total** error count.                                                                                                                                    |
| `npm run check:bundle`      | The built `dist/performance-helpers.cjs` exports everything `src/index.js` declares, and is not older than `src/`. Run by `verify` after `build`; must run _outside_ vitest to be meaningful. |

Neither project is at zero, and neither can be fixed in one sitting, so the
gate is on direction rather than on zero: **the count may fall, never rise.**

```bash
npm run typecheck:ratchet              # the gate
npm run typecheck:ratchet -- --verbose # ... with the full tsc output
npm run typecheck:ratchet -- --update  # print the new BASELINE line
```

`BASELINE` lives at the top of `scripts/typecheck-ratchet.cjs`. If your change
_fixes_ type errors, lower it. If your change _adds_ them, fix them - do not
raise the ceiling to make the build pass. A genuine exception (a new file that
is itself known debt) should raise it, and say so in the PR, so the increase is
deliberate rather than accidental.

`npm run test:types` is the one that matters for consumers: it is the only thing
verifying the declarations that actually ship. If you change public JSDoc, run
`npm run types:generate` and commit the result.

## Releases

Releases are automated with [changesets](https://github.com/changesets/changesets).
**Never bump `version` in `package.json` by hand, and never run `npm publish`
by hand** - the workflow owns both.

The loop:

1. On your branch, add a changeset for anything a consumer can observe:

   ```bash
   npm run changeset
   ```

   Choose `major` / `minor` / `patch` and write the entry for the reader of the
   changelog, not for the reader of the diff. For a change that genuinely needs
   no release (docs, tests, an internal refactor), use
   `npx changeset add --empty` instead - CI requires a changeset on any PR that
   touches the package.

2. Open a PR. CI runs the full gate, including `changeset status`.

3. On merge to `main`, the **Release** workflow opens a _"chore: version
   packages"_ PR containing the version bump, the regenerated `types/*.d.ts`,
   and `CHANGELOG.md`. That PR is the reviewable record of what the release
   contains.

4. Merging that PR publishes to npm. The publish step runs `prepublishOnly`, so
   the gate applies to releases exactly as it applies locally.

To cut a release by hand instead of waiting for CI:

```bash
npm run release:version   # changeset version + regenerate types + stage
npm run release:publish   # changeset publish (runs prepublishOnly first)
```

`.changeset/README.md` covers the changeset format in more detail.

## Coding guidelines

- Prefer plain JavaScript and small abstractions over framework-style layering.
- Keep hot-path allocations and hidden work low.
- Avoid adding dependencies unless there is a clear, durable payoff.
- Preserve the existing naming style and file organization.
- Write examples and docs using realistic usage patterns, not placeholder pseudocode.
- When changing helper behavior, consider edge cases such as timeouts, cancellation, queue saturation, expiry, and cleanup.

## Testing expectations

- Add focused tests near the affected helper area in `test/`.
- Cover both normal behavior and failure or edge cases.
- Prefer narrow, explicit tests over large multi-concern tests.
- If a helper has concurrency, timing, or retry behavior, test the boundary conditions.
- Keep the repository-wide coverage baseline green; use helper-specific work to raise weaker files toward Tier 1.

## Tier 1 helper checklist

Use this checklist when promoting or maintaining a helper as Tier 1:

- The helper has a dedicated guide and a README entry.
- Public methods and constructor options have concise JSDoc with edge-case behavior spelled out.
- Behavior-changing work includes focused regression tests.
- The helper keeps per-file coverage at or above the repository targets during promotion, with branch coverage treated as mandatory.
- Known correctness issues are fixed before broadening the API.
- Performance-sensitive paths avoid avoidable allocations, duplicate clocks, and duplicated state machines.
- If the helper composes other helpers, shared substrate should be reused instead of reimplemented.

Helpers that cannot satisfy this bar without excessive complexity should stay advanced or internal until their scope is reduced.

Current exceptions to treat deliberately rather than mechanically:

- `PowerPool` is an advanced helper. Its scope is intentionally broader than most helpers here, so promotion work should focus on correctness, docs, and high-value edge cases instead of forcing it into the same maintenance profile as the smallest primitives.
- `PowerRateLimit` currently has an anomalous function-coverage number despite strong public-path coverage. Do not treat that metric alone as proof of missing behavior unless a concrete branch or regression is identified.
- For broad helpers, prefer documenting scope and trade-offs over adding low-value tests that only improve a report without increasing confidence.

## Documentation expectations

Update documentation when any of the following changes:

- public API
- constructor options
- method semantics
- examples
- performance trade-offs
- recommended helper combinations

At minimum, check whether one of these files needs an update:

- `README.md`
- `guides/*.md`
- `guides/metaGuide.md`

## Pull requests

A good pull request should include:

- a clear problem statement
- a concise summary of the change
- tests for behavior changes
- docs updates when user-facing behavior changed
- notes about benchmark impact when performance-sensitive code changed

If the change affects runtime cost, concurrency, or memory behavior, include benchmark numbers or at least a short explanation of the expected trade-off.

## Scope guidance

Good contributions:

- bug fixes
- test improvements
- documentation clarifications
- performance improvements with evidence
- small, coherent helper enhancements

Higher-risk changes that need extra care:

- public API redesigns
- new dependencies
- behavior changes in core helpers like cache, pool, queue, retry, or rate limiting
- changes that make examples or guides drift from the actual implementation

## Questions

If you are unsure whether a change fits the project, open an issue or draft PR with the intended API, behavior, and trade-offs before expanding the implementation.
