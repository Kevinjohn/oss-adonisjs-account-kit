# 0.2.0 candidate release gate

The release candidate is the archive built from source `1ef240c72c4445482baf8f30b806b9128550d811`, with SHA-256 `3c38c999a0d6eb6c5c17663b9c77ce99c87ccc6a0d7f0b9104742ea1d596d693`. The required source, distribution, recipe and reference-example checks passed against that unchanged archive. The dated [second-alpha verification record](verification.md#second-alpha-020-candidate) records the initial test-source failure, correction, successful reruns and remaining owner checks; historical totals do not substitute for this evidence. See the [compatibility assessment](../compatibility.md) for supported dependency floors and boundaries.

## Owner release decision

The current distribution is the GitHub release tarball, as for the advertised `0.1.1` release. Publish `0.2.0` through that route only after the exact candidate checks and final review are complete and recorded. npm publication is a separate future decision; this gate does not assume an npm package, a first-publish name check, or npm signature verification.

Merge and publish actions belong to the repository owner. After publication, the owner must separately install the advertised release using the root [README install instructions](../../README.md#install) in a fresh application and verify that the documented install path resolves the published artifact. That post-publication smoke check is not satisfied by candidate archive tests.

The owner also performs any manual viewport, keyboard, or other checks outside the automated suites. They remain owner checks and are not represented as completed by the candidate test runs.

## Upgrade and rollback

The comparison with the actual published `0.1.1` tarball found all 313 files under `package/build/` byte-identical, including 14 configuration and migration templates. There is no source delta in `src/`, `adapters/`, `commands/`, `providers/`, `services/`, `http/`, `testing/`, `stubs/`, `configure.ts`, or `index.ts`. Version `0.2.0` therefore adds no package-generated configuration or migration; follow the existing configuration and migration guidance in [usage](../usage.md).

Application-owned policies and configuration remain authoritative during an upgrade and rollback. Credentials and committed outbox entries also remain authoritative: rolling back to `0.1.1` does not undo committed credential changes or make delivered or pending outbox work disappear. Recover pending effects through the application's existing outbox process; do not replay consumed bearer credentials.

The pre-`0.1.0` schema caveat is historical: unreleased migration stubs were squashed to create the final schema directly, so a database made by those earlier unreleased builds has no in-place upgrade path. Reset that database and run the current migrations. This caveat does not describe an upgrade from the published `0.1.1` package to `0.2.0`.
