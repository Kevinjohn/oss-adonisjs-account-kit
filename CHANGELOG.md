# Changelog

This project has no published releases yet. The current candidate remains version `0.0.0`.

## Unreleased

### Added

- Recovery, email verification, invitations, password changes, and verified email changes with
  package-owned transactions and application callbacks.
- A maintained lazy Lucid adapter that derives the model table, validates the physical `id` key
  and default connection, uses model save hooks for password hashing, and maps registration data
  through an explicit trusted callback.
- Optional capability selection, namespaced HMAC limiter keys, invitation-specific budgets, and
  paged invitation listing.
- Transactional credential-change callbacks, credential notices, and safe lifecycle events.
- A fifth configure migration for the SQLite package transaction-lock table.
- Bounded expired-token pruning through an explicit Ace command; pruning is not scheduled
  automatically.

### Changed

- Configuration requires a stable limiter secret of at least 32 bytes. Applications should use a
  stable `APP_KEY` shared by instances using the same limiter store. Secret rotation resets limiter
  buckets.
- `onCredentialsChangedTransaction(user, context, trx)` is the transaction-aware credential
  revocation hook. It is mutually exclusive with the legacy post-commit
  `onCredentialsChanged(user, context)` hook.
- Recovery notification failures remain generic at the HTTP boundary. A failed post-commit effect
  can be reported with `committed: true`; the database transaction has already committed.
- Configure accepts `--users-table` and `--user-id-type` (`integer`, `string`, or `uuid`) for newly
  generated migrations. Existing generated config and migration files are not rewritten.

### Integration notes

- Registration attributes are untrusted. Applications must map only validated profile data in
  `mapRegistrationData`; identity, email, password, verification, and role fields remain controlled
  by the adapter and account operation.
- Enabled capabilities default to all capabilities. When supplying a subset, configure only the
  callbacks required by those capabilities; calling a disabled operation fails explicitly.
- Review the [upgrade guide](docs/upgrade.md) before applying these contracts to an existing
  installation. Current evidence is tracked in [verification](docs/verification.md).
