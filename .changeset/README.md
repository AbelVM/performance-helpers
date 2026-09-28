# Changesets

This directory holds the release automation for `performance-helpers`
(**CFG-004**). Nothing here is read at runtime; it only affects how a release is
cut.

## The loop

1. Work on a branch. Every user-visible change gets a changeset:

   ```sh
   npx changeset          # or: npm run changeset
   ```

   Pick `major` / `minor` / `patch` and write a sentence in the consumer's voice
   ("PowerPool now frames messages by default", not "refactored codec").

2. Open a PR. CI runs the full gate; the changeset is a normal file in the diff.

3. On merge to `main`, the **Release** workflow opens (or updates) a
   *"chore: version packages"* PR. That PR contains the version bump, the
   regenerated `types/*.d.ts`, and `CHANGELOG.md`.

4. Merging that PR publishes to npm.

## Rules

- **A changeset is required for anything a consumer can observe** — a new
  helper, a changed default, a fixed bug, a deprecation, a new option. Pure
  internal refactors, test-only changes and doc typos do not need one
  (`patch` is still fine if you would rather not argue about it).
- **Write the changelog entry for the reader, not for the diff.** It is the only
  thing most people ever see.
- Breaking changes are `major` even when they are not type-level. The
  `PowerPool` framed protocol (2.0) is the example: it is a runtime break for
  every existing worker.
- `types/*.d.ts` is committed. `npm run release:version` regenerates it as part
  of the version step, and `npm run verify` fails if it drifts from `src/`.
  Never hand-edit a `.d.ts`.

See `CONTRIBUTING.md` for the surrounding command reference.
