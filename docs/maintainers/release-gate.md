# Release gate and historical candidate evidence

Follow [Releasing](releasing.md) for the current GitHub release procedure. The release workflow
runs `checks`, `compat` and `examples` as prerequisites, then runs `bin/release_check.sh` before
creating the prerelease. The documentation site build is a separate workflow gate.

The local release script checks that the version tag does not already exist, requires a dated
changelog section for that version and an empty Unreleased section, then builds and packs the
working-tree candidate. It writes the archive path, version and release notes with the archive's
SHA-256. Running the local script alone does not execute the workflow's prerequisite jobs.

Before running the release workflow, the owner performs any manual viewport, keyboard or other
checks outside the automated suites. Candidate test runs do not record those checks as completed.

## Reviewed starting baseline — 4 November 2026

The remediation review started at source `8a60eee1b6f2b5ccd9c9a74e9f488d6bbadcd3a5`, with
manifest and changelog version `0.2.0`. No archive hash or present check result is assigned to
that baseline here. Each later candidate needs its own source revision, actual consumed archive,
checksum and applicable check results. A version label alone does not identify its bytes.

## Historical second-alpha candidate — 22 October 2026

The [dated second-alpha record](verification.md#second-alpha-020-candidate) identifies archive
source `1ef240c72c4445482baf8f30b806b9128550d811` and SHA-256
`3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693`. It preserves the initial
test-source failure, correction, reruns and remaining owner checks. Keep its execution and
publication boundaries with that historical candidate.

## Upgrade and rollback

The historical record compared the published `0.1.1` tarball with its identified candidate and found all
313 files under `package/build/` byte-identical, including 14 configuration and migration
templates. That comparison applies only to those archives. Assess current upgrades against the
[current changelog](../../CHANGELOG.md), [usage](../guide/usage.md) and
[compatibility assessment](../reference/compatibility.md), including their configuration and
migration requirements.

Application policies, credentials and committed outbox entries remain application-owned during
an upgrade or rollback. A package rollback does not undo committed credential changes or
remove delivered or pending outbox work. Recover pending effects through the application's
existing outbox process and preserve consumed-proof boundaries.

The pre-`0.1.0` schema caveat is historical: unreleased migration stubs were squashed into the
final schema, so a database created from those earlier unreleased builds needs a reset rather
than an in-place upgrade. The dated verification record retains that context.

After a release is published, verify the advertised README install path in a fresh application
using the published bytes. Candidate archive tests establish their own inputs and do not
establish this post-publication install result.
