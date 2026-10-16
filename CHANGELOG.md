# Changelog

This project has no published releases yet. The current candidate remains version `0.0.0`.

## Unreleased

### Added

- `AccountKit.registration.register` (export) creates inactive accounts with trusted mapped fields, a durable activation proof, and uniform duplicate-email errors.
- `registration.availability` (required config key) selects open/closed/application admission and defaults to open in generated config; `registration.mapFields` (config key) selects trusted additional fields.
- Configured `registration.mapFields` now receives `undefined` when profile input is omitted, so required application fields can reject registration; mapped output must be a plain object.
- `passwordPolicy` (config key) applies Plus-style rules to newly established passwords with a 256-character service ceiling.
- The API example signup establishes a limited bearer token or browser session and denies protected access until verification.
- `AccountKit.authentication` adds named session or opaque-token login, failed-attempt limits, safe current-account access, and current-credential logout.
- `authentication.changeRestriction` records package-managed access-policy changes and revokes credentials through the selected guard policy.
- `users.credentials_changed_at` (column) invalidates existing browser sessions and login attempts using superseded account evidence.
- The API example provides session CSRF bootstrap, browser logout, and selected-guard access middleware for protected routes.
- Inactive accounts may correct an unconfirmed email through the limited credential gate while verified routes still reject them.
- The API example checks token abilities before sending invitations and returns `missing_ability` for a token without permission.
- Read-only activation and email-change proof inspection methods check current account state without consuming a link.
- `emailPasswordManagement.updateProfile` writes only mapped registration fields and optional pending email under one current-password-protected transaction.

- `users.unverified_email` (column) records a pending address; active state follows the confirmed/pending pair.
- `email_verification_tokens` (table) stores hashed, expiring, single-use activation and email-change proofs.
- `social_identities` (table) stores unique provider subjects and user-linked identity metadata without credentials.
- `tokenSecretLength` (config key) defaults to 40 bytes.
- An isolated packed service-only consumer check covers compilation and startup on both databases without backend-only dependencies.

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

- `emailVerification.complete({ token })` → `emailVerification.complete({ token, password })` (export contract) for inactive account claims; the claim replaces the earlier password and invalidates earlier credentials.
- `GET /account-kit/verification/:token` → `POST /account-kit/verification/:token` (API example route) with password and confirmation in the body.
- The API example's password validator maximum changes from 128 to 256 characters to match the service ceiling.
- `passwordPolicy.minScore` (config key) now scores password length and character variety, and its TypeScript type is `0 | 1 | 2 | 3 | 4`.
- `emailVerification` (adapter capability contract) requires `UsersAdapter.setPassword` to replace an earlier password during inactive activation.
- The generated `enabled` (config key) and the runtime default omit invitations; applications opt in explicitly.
- Password and confirmed-email changes and password resets now delete all user access tokens transactionally in token mode or advance the browser-session revision in session mode.
- Repeated activation or same-pending-address requests within one minute preserve the existing live proof and acknowledgement without another message.
- Inactive-account email replacement now sends an activation link that requires a fresh password to claim the account.

- `UsersAdapter.create({ email, password, emailVerifiedAt, registrationData? })` → `UsersAdapter.create({ email, unverifiedEmail, password, registrationData? })` (export contract).
- `AccountUser.emailVerifiedAt` authorization state → `AccountUser.unverifiedEmail` confirmed/pending authorization state (export contract); the timestamp remains audit metadata.
- `UsersAdapter.setUnverifiedEmail` (export contract) is required for pending-address writes.
- `UsersAdapter.markEmailVerified` (export contract) now clears `unverifiedEmail` while recording the audit timestamp.
- Email-verification-only configuration no longer requires `UsersAdapter.setEmail` (adapter capability contract).
- `PruneCounts.emailChanges` → `PruneCounts.emailVerifications` (export property).
- `emailVerification.complete` return type `'verified' | 'already_verified'` → `'verified'` (export contract); replay now rejects an invalid proof.
- `users.password NOT NULL` → `users.password NULL` (column), allowing no local password.
- `password_reset_tokens.user_id` → `password_reset_tokens.tokenable_id` (column).
- `password_reset_tokens.token_hash` → `password_reset_tokens.hash` (column).
- `account_email_changes` → `email_verification_tokens` (table) for pending email-change proofs.
- Repeatable encrypted activation link → stored, hashed, one-use activation proof (service contract).
- An inactive account's email change now updates both confirmed and pending addresses and invalidates the prior proof (service contract).
- Password reset and password change now cancel a distinct pending email change in the same transaction (service contract).
- Inactive-account email changes now run the configured credential revocation hook when the confirmed address changes, transactionally or after commit (service contract).
- Activation completion still delivers `verification.completed` after a committed transaction cleanup failure, then reports the committed fault.

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
- Enabled capabilities default to password reset, email verification, and email/password
  management; registration and invitations require explicit opt-in. When supplying a subset, configure only the
  callbacks required by those capabilities; calling a disabled operation fails explicitly.
- Review the [upgrade guide](docs/upgrade.md) before applying these contracts to an existing
  installation. Current evidence is tracked in [verification](docs/verification.md).
