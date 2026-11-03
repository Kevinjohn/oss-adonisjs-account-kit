# Releasing

1. On a branch, bump `version` in `package.json` and turn `## Unreleased` into
   `## <version> - <YYYY-MM-DD>` (add a new empty `## Unreleased` above it).
2. Merge the PR.
3. Actions → release → Run workflow (on `main`).

Nothing else is manual. The release is a GitHub prerelease with the tarball attached; its notes
carry the install command and the SHA-256. `bash bin/release_check.sh` runs the same gate locally.
