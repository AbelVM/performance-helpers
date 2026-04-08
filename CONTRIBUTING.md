# Contributing

Thanks for contributing to `performance-helpers`.

This project is a small, performance-focused JavaScript toolbox for Node.js and browser runtimes. Contributions should stay consistent with that goal: small APIs, predictable behavior, low overhead, and clear documentation.

Repository: <https://github.com/AbelVM/performance-helpers>

## Prerequisites

- Node.js 16 or newer
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
5. Run the relevant validation commands before opening a PR.

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
