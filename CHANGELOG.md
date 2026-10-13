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
- PostgreSQL and SQLite transaction support. Package writes own their root transaction and reject
  an already-active global transaction on either dialect. SQLite write contention retries
  asynchronously for up to five seconds; PostgreSQL does not retry. Transaction callbacks must
  keep writes inside the supplied transaction and avoid external side effects.
- Documented consumer setup and local test workflows in `README.md`.
- `usersTable` configuration option (default `users`) for applications whose user model uses
  another table name; SQLite row locks and duplicate-email classification follow it.

### Fixed

- A failing `onCredentialsChanged` callback no longer suppresses the `notify.emailChanged`
  security notice after a committed email change; both post-commit effects run and a
  `PostCommitError` carries one cause or an `AggregateError` of both.
- `recovery.request` rejects a missing or blank `clientKey` with `InvalidInputError` instead of
  throttling every caller in one shared bucket.
- The provider throws a configuration error when `config/account_kit.ts` is missing instead of
  failing later inside the first operation.
- Generated URL callbacks keep any path in `APP_URL`, so applications served under a sub-path get
  correct links. Configure declares `APP_URL` in `start/env.ts` when that file exists.
- SQLite locks quote configured table names, including reserved identifiers. PostgreSQL duplicate
  classification follows the database's 63-byte constraint-name limit. Custom-table setup documents
  all application-owned migration targets and has service-level workflow and conflict coverage.

- PostgreSQL commit failures reject the operation and suppress commit events and external effects.
  Both database clients reject package writes inside a global transaction.
- Credential operations acquire user locks before token locks and revalidate token consumption
  after the initial lookup, preventing the former opposing lock order.
- SQLite duplicate-email classification matches exact qualified column names, including errors
  prefixed by Lucid queries. PostgreSQL's supported constraint name is an explicit adapter rule.
- Invalid request timing, throttle settings, optional callbacks and out-of-range token lifetimes
  fail during configuration. Recovery rollback coverage includes a password write before failure.
- Generated email lookups use indexed normalized equality. String-ID workflows have coverage with
  matching migration foreign keys. Built package exports have an explicit local smoke gate.
- Recovery documentation describes the minimum duration as a mitigation rather than a timing
  guarantee. Manual release tooling uses pnpm for versioning and publication.

### Integration requirements

- Applications provide a `UsersAdapter` that normalizes email addresses before storage and enforces
  a unique email index (`<usersTable>_email_unique` on PostgreSQL), hashes passwords, uses the supplied
  transaction for transaction-aware methods, and locks user rows on PostgreSQL when requested.
- Applications configure required authorization, URL, notification, and invitation-acceptance
  callbacks. `onInvitationAccepted` performs application role assignment inside the transaction;
  credential callbacks and notifications run after commit.
- Password policy, confirmation fields, routes, controllers, validators, and user interface are
  application responsibilities.

### Validation

- The account-operation refactor and custom-table corrections pass 138 SQLite tests, 139
  PostgreSQL tests, lint, typecheck, build and three built-export tests. Four real-schema custom-table
  cases cover reserved and long identifiers, migration adaptation, operations and duplicate rollback.
- At accepted stage-6 source commit `64e154203c0bf1aaf36957e97f39f2d440aa2ccb`, package tests
  passed with 121 SQLite tests and 123 PostgreSQL tests. A later SQLite-only regression test raised
  the pre-correction totals to 122 SQLite tests and 123 PostgreSQL tests.
- The review corrections pass 129 SQLite tests and 130 PostgreSQL tests, lint, typecheck, build,
  and the two-test built-export smoke gate. Runtime source now includes the corrections above.
- Local checks are authoritative during package development. Repository validation workflows are
  manual-only; no Actions execution is claimed.
- A fresh API-kit consumer passed one HTTP workflow test per database; an upgrade from the stage-3
  package archive passed two HTTP tests per database. Both consumer rehearsals passed typecheck.
  Configure preserved existing configuration and migrations during upgrade. Full details are in
  [`docs/manual-check.md`](docs/manual-check.md).
- The repaired archive passed pnpm installation, consumer typecheck and two HTTP tests per
  database in a private copy of the configured API consumer.
