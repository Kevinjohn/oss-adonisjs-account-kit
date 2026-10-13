# Changelog

This project has no published releases yet. The entries below describe the current unreleased
package candidate; they do not represent a stable `1.0.0` release.

## Unreleased

### Added

- Account recovery with expiring, single-use hashed tokens, inspection, and password reset.
- Purpose-bound email verification links with current-address checks.
- Invitations with authorization, expiry, listing, inspection, acceptance, resend, and revoke
  operations.
- Credential changes with current-password proof, password changes, and verified email changes.
- Configurable token lifetimes, request throttles, authorization callbacks, and post-commit
  notifications.
- `node ace configure adonisjs-account-kit` setup that registers the provider and creates the
  package config plus four migrations: `create_account_recovery_tokens`,
  `create_account_invitations`, `create_account_email_changes`, and
  `add_email_verified_at_to_users`.
- PostgreSQL and SQLite transaction support. SQLite write contention retries asynchronously for
  up to five seconds; transaction callbacks must keep writes inside the supplied transaction and
  avoid external side effects.
- Documented consumer setup and local test workflows in `README.md`.

### Integration requirements

- Applications provide a `UsersAdapter` that normalizes and uniquely indexes email addresses,
  hashes passwords, uses the supplied transaction for transaction-aware methods, and locks user
  rows on PostgreSQL when requested.
- Applications configure required authorization, URL, notification, and invitation-acceptance
  callbacks. `onInvitationAccepted` performs application role assignment inside the transaction;
  credential callbacks and notifications run after commit.
- Password policy, confirmation fields, routes, controllers, validators, and user interface are
  application responsibilities.

### Validation

- At accepted stage-6 source commit `64e154203c0bf1aaf36957e97f39f2d440aa2ccb`, package tests
  passed with 121 SQLite tests and 123 PostgreSQL tests. A later SQLite-only regression test raised
  the current totals to 122 SQLite tests and 123 PostgreSQL tests; runtime source is unchanged.
  Current build, lint, and typecheck passed.
- Local checks are authoritative during package development. Repository validation workflows are
  manual-only; no Actions execution is claimed.
- A fresh API-kit consumer passed one HTTP workflow test per database; an upgrade from the stage-3
  package archive passed two HTTP tests per database. Both consumer rehearsals passed typecheck.
  Configure preserved existing configuration and migrations during upgrade. Full details are in
  [`docs/manual-check.md`](docs/manual-check.md).
