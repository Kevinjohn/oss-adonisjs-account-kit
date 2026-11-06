# Releasing

1. On a branch, bump `version` in `package.json` and turn `## Unreleased` into
   `## <version> - <YYYY-MM-DD>` (add a new empty `## Unreleased` above it).
2. Update the public `README.md` install command, asset filename and release-note link to that
   exact version. Review version-bearing examples and integration instructions in the same
   branch. When changing a pinned sibling-package archive, update its URL, version and checksum
   together; an Account Kit version bump does not select a new Masquerade release automatically.
3. Merge the PR.
4. Actions → release → Run workflow (on `main`).

Apart from the owner checks in the [release gate](release-gate.md), nothing else is manual. The
release is a GitHub prerelease with the tarball attached; its notes carry the install command and
the SHA-256. `bash bin/release_check.sh` runs the same gate locally.
The workflow does not rewrite version-bearing documentation for you. It requires successful
`checks`, `compat` and `examples` jobs. A `package` job with the default read-only token then
runs the gate, builds, packs and uploads `tmp/release/` as an artifact. A separate `release` job
is the only one with `contents: write`; it checks out nothing, installs nothing, downloads that
artifact and runs `gh release create`, so no install or build script ever holds a token that can
publish.

Use `Added`, `Changed`, `Fixed` and `Removed` sections as applicable for new entries, with
breaking changes identified explicitly under `Changed`. Preserve published release wording;
apply this format prospectively rather than rewriting history for style.
