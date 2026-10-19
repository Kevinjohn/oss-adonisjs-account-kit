# Local candidate and future release gate

The candidate is prepared through local package checks, an independent review, and installation of the exact packed archive in fresh and upgraded Adonis API consumers. Both SQLite and PostgreSQL must pass. Review the [verification record](verification.md), [compatibility assessment](../compatibility.md) before a release decision.

## Owner-controlled release actions

Choose the published package name/scope and first version before publication. Confirm the supported peer floors against the measured compatibility matrix, assess unresolved dependency advisories in the full consumer install, and finish any application integration required for the release. Universal session revocation, tenant membership, the external starter integration and UI scaffolding remain separate work.

After publishing, run the README install commands in a fresh API starter app against the registry,
and check that the npm badge and `npm audit signatures` resolve. Until the first publish,
`node ace add adonisjs-account-kit` returns 404.

The check workflow runs on pushes to `main`, on pull requests, by hand and from the release
workflow. Push and pull request runs are skipped while the repository is private, so they only use
hosted minutes once it is public.

Keep both database matrix jobs, Node 24, pnpm, lint, typecheck, tests, build and built-export checks. Add the installed-consumer/adapter gates once their local commands are accepted for hosted use, and make both database results required in branch protection. The conditional empty service image for SQLite is supported and does not need replacement.

## Upgrade and rollback

Back up deployed application config and migrations. Install the candidate, reconfigure without overwriting owned files, manually update configuration and apply the new package lock migration before serving the new SQLite write path. Rehearse the application-owned registration mapping and credential policy before accepting traffic.

For vocabulary alignment, also rename the reset-token table in place (the `evolve_identity_contract`
migration) and update service calls, callbacks and lifecycle listeners during a maintenance window. Preserve
outstanding reset-token rows; fresh create-table stubs do not migrate existing data.

A rollback to the baseline package must restore its compatible config API. The added lock table can remain unused; avoid destructive migration rollback while any candidate process is running. Credential changes and durable outbox entries already committed remain authoritative. Do not replay consumed bearer tokens after a post-commit error; recover queued effects from the outbox.

Restore the previous reset-token table name before restarting old package code. Do not run old
and new code together while their table names differ.

No release or publication is performed by these steps.
