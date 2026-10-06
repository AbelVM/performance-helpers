---
'performance-helpers': patch
---

The Release workflow's `version` job failed on every release: it used
`changesets/action` with `commit`/`title`, which pushes the version commit to a
branch and then creates a "chore: version packages" pull request, and this
repository does not permit GitHub Actions to create or approve pull requests.
The job errored after cutting the version and before `publish` ran, so nothing
shipped. A job-level `pull-requests: write` permission cannot fix it — that is a
repository setting, not a workflow permission.

The job is deleted. The version cut is now made by a maintainer pushing to `main`
(`changeset version`, or `npm run release:version`), and `publish` runs
`changeset publish` on every push to `main`, which no-ops when the version on
npm already matches `package.json` — so a non-version push is a cheap no-op
rather than a failed release. The version PR was only ever a review surface for
the `package.json` + `CHANGELOG.md` + `types/` diff, and that diff still lands on
`main` in the maintainer's own commit.
