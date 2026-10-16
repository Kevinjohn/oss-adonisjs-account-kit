# Changelog

This project has no published releases yet. The current candidate remains version `0.0.0`.

## Unreleased

### Added

- Password reset, email verification, invitations, password changes, and verified email changes with
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

- `recovery (capability)` → `passwordReset` (config key).
- `verification (capability)` → `emailVerification` (config key).
- `credentials (capability)` → `emailPasswordManagement` (config key).
- `AccountKit.recovery` → `AccountKit.passwordReset` (export).
- `AccountKit.verification` → `AccountKit.emailVerification` (export).
- `AccountKit.credentials` → `AccountKit.emailPasswordManagement` (export).
- `RecoveryRequestInput` → `PasswordResetRequestInput` (export).
- `RecoveryInspectInput` → `PasswordResetInspectInput` (export).
- `RecoveryResetInput` → `PasswordResetCompleteInput` (export).
- `CredentialsChangePasswordInput` → `ChangePasswordInput` (export).
- `CredentialsRequestEmailChangeInput` → `RequestEmailChangeInput` (export).
- `CredentialsCompleteEmailChangeInput` → `CompleteEmailChangeInput` (export).
- `urls.recovery` → `urls.passwordReset` (config key).
- `urls.verification` → `urls.emailVerification` (config key).
- `notify.recovery` → `notify.passwordResetProvision` (config key).
- `notify.passwordReset` → `notify.passwordResetCompleted` (config key).
- `notify.verification` → `notify.accountActivationProvision` (config key).
- `notify.invitation` → `notify.invitationProvision` (config key).
- `notify.emailChangeConfirm` → `notify.emailChangeProvision` (config key).
- `onRecoveryIssuedTransaction` → `onPasswordResetIssuedTransaction` (config key).
- `recovery.requested` → `password_reset.requested` (event).
- `ttl` → `expiresIn` (config key).
- `ttl.recovery` → `expiresIn.passwordReset` (config key).
- `ttl.verification` → `expiresIn.emailVerification` (config key).
- `ttl.invitation` → `expiresIn.invitation` (config key).
- `ttl.emailChange` → `expiresIn.emailChange` (config key).
- `account_recovery_tokens` → `password_reset_tokens` (table).
- `requestRecovery` → `requestPasswordReset` (export).
- `inspectRecovery` → `inspectPasswordReset` (export).
- `resetRecovery` → `completePasswordReset` (export).
- `AccountRecoveryTokenSchema` → `PasswordResetTokenSchema` (export).
- `src/recovery.ts` → `src/password_reset.ts` (file).
- `stubs/migrations/create_account_recovery_tokens.stub` → `stubs/migrations/create_password_reset_tokens.stub` (file).
- `*_account_kit_create_account_recovery_tokens.ts` → `*_account_kit_create_password_reset_tokens.ts` (file).
- `examples/api/upgrade/baseline_account_kit.ts` → `examples/api/upgrade/baseline_account_kit.stub` (file).
- `tests/recovery.spec.ts` → `tests/password_reset.spec.ts` (file).

- `recovery (package keyword)` → `password-reset` (doc).
- `verification (package keyword)` → `email-verification` (doc).
- `Account recovery / credential changes (package description)` → `Password reset / email and password management` (doc).
- `Recovery (flow terminology)` → `Forgot password / password reset` (doc).
- `MINIMUM_STAGE recovery-requested` → `MINIMUM_STAGE password-reset-requested` (doc).
- `MINIMUM_STAGE verification-send-complete-verified-replay` → `MINIMUM_STAGE email-verification-send-complete-verified-replay` (doc).
- `MINIMUM_PUBLIC_OPERATIONS: recovery` → `MINIMUM_PUBLIC_OPERATIONS: passwordReset` (doc).
- `MINIMUM_PUBLIC_OPERATIONS: verification` → `MINIMUM_PUBLIC_OPERATIONS: emailVerification` (doc).

- Configuration requires a stable limiter secret of at least 32 bytes. Applications should use a
  stable `APP_KEY` shared by instances using the same limiter store. Secret rotation resets limiter
  buckets.
- `onCredentialsChangedTransaction(user, context, trx)` is the transaction-aware credential
  revocation hook. It is mutually exclusive with the legacy post-commit
  `onCredentialsChanged(user, context)` hook.
- Password reset notification failures remain generic at the HTTP boundary. A failed post-commit effect
  can be reported with `committed: true`; the database transaction has already committed.
- Configure accepts `--users-table` and `--user-id-type` (`integer`, `string`, or `uuid`) for newly
  generated migrations. Existing generated config and migration files are not rewritten.

### Fixed

- Package archives exclude private planning and review documents while retaining public docs and examples.
- Installed-consumer upgrade checks preserve an outstanding password-reset proof through the table rename and verify one-time redemption.
- Minimum-consumer diagnostic markers use the current password-reset and email-verification vocabulary.
- Email-change requests and completions, invitation sends and invitation acceptance now run their
  notices, link deliveries, legacy credential callbacks and lifecycle events when the transaction
  commits but connection cleanup or a commit listener then fails. The operation still reports
  `PostCommitError` with `committed: true`.

### Integration notes

- Registration attributes are untrusted. Applications must map only validated profile data in
  `mapRegistrationData`; identity, email, password, verification, and role fields remain controlled
  by the adapter and account operation.
- Enabled capabilities default to all capabilities. When supplying a subset, configure only the
  callbacks required by those capabilities; calling a disabled operation fails explicitly.
- Review the [upgrade guide](docs/upgrade.md) before applying these contracts to an existing
  installation. Current evidence is tracked in [verification](docs/verification.md).
