# Changelog

## Unreleased

- Document example distribution prerequisites and expose API proof links only in development for contributor smoke checks.

- Document a shared account-journey acceptance contract and distinguish example implementation from verification evidence.

- Add profile and pending-email settings with explicit email-change confirmation to the Inertia example.
- Recover the Inertia example signup flow when account creation commits but notification or initial sign-in fails.
- Improve account example contrast, keyboard focus, page landmarks, reduced motion, and narrow-screen layout.

Initial public release.

### Added

- Account forms in the Inertia example announce validation errors, focus a field summary, and use
  readable field names; the reset recipe includes labeled inputs and matching error keys.
- The Inertia example accepts password-reset links during an existing session, signs out after a
  successful reset, ends the current browser session before redirecting from completed email
  verification, and describes invalid, used, or expired proof links accurately.
- Password reset with single-use, expiring, hashed proof tokens and a generic response for unknown
  addresses.
- Email verification and self-service registration with open, closed or application-controlled
  admission and trusted mapping of extra profile fields.
- Invitations with role, authorization callbacks, resend, revoke, cursor-paged listing and
  separate actor and recipient rate limits.
- An invitation is accepted when its address is first confirmed without the link: a new social
  account with a provider-verified address, account activation, or a password reset that confirms
  the account. `onInvitationAccepted` runs in that transaction and `invitation.accepted` is
  reported after commit.
- Password change, verified email change and profile updates behind the current password.
- A self-service password change can keep the caller's own sign-in (`keepCurrent`) and returns
  the new credential revision. The managed route keeps the calling session or token, and the
  managed session guard gains `refresh(revision)`. `passwordChangeRevision(error)` returns the
  committed revision from a `PostCommitError`, so the caller's session survives a failed follow-up.
- Users adapters can hash a new password before the write transaction opens (optional
  `hashPassword` and `setPasswordHash`; `create` receives `passwordHash`). The shipped adapters
  implement both, so a slow hash no longer holds the SQLite writer. Reset and activation completion
  now hash before the token is checked; throttle the routes that call them.
- Session and opaque-token login through an existing AdonisJS Auth guard, with failed-attempt
  limits and credential revocation on every credential change.
- Optional Google and GitHub social sign-in through Ally, with safe linking, recent proof and a
  one-time PKCE handoff.
- Optional magic-link sign-in (`magicLinkLogin`, `kit.magicLink`): a one-use, 15-minute email link
  bound to the requesting client by a PKCE-style verifier, for session and access-token guards,
  with managed routes under `auth/magic-link`, the `magicLinkProvision` email, the
  `E_ACCOUNT_KIT_INVALID_MAGIC_LINK` managed error code, setup support and pruning. Every credential change
  deletes outstanding links, so the `login_link_tokens` table is required in every
  installation.
- Optional sign-in management (`sessionManagement`, `kit.authentication.sessions`): list the
  account's sessions or access tokens and revoke one, all others, or all, with managed routes under
  `account/sessions`, `SessionNotFoundError`, setup support and pruning. Session sign-ins are
  recorded in the `account_sessions` table, which every credential change clears, so the table
  is required whenever `authentication` is configured.
- Optional account export and deletion (`dataExport`, `accountDeletion`, `kit.accountData`): a
  versioned JSON export merged with `exportAccountData`, and permanent deletion of every package row
  and the user row with `onAccountDeletingTransaction`, an `accountDeleted` email and the
  `account.deleted` lifecycle event. Both need fresh re-authentication (current password or an
  `account_export` / `account_delete` proof). Managed routes `POST account/export` and
  `DELETE account`, the optional `UsersAdapter.delete` (Lucid adapter and contract suite included),
  and setup support.
- Built-in account emails for AdonisJS Mail, trusted action-link builders and a notification
  readiness check.
- An optional managed JSON backend (`adonisjs-account-kit/http`) for apps that do not want to own
  the routes.
- A Lucid users adapter and a reusable adapter contract suite for custom adapters.
- Ace commands: `account-kit:setup`, `account-kit:prune`, `account-kit:retirement-impact` and
  `account-kit:doctor`, which checks config, limiter, `APP_URL` and database tables.
- `account-kit:doctor` also checks deletion cleanup tables and password nullability for enabled
  passwordless social registration, then names the callback and credential flows it did not test.
- `createLogNotifications` prints account emails and their links to the logger during development.
- `createMailNotifications` and `createLogNotifications` resolve the AdonisJS Mail and logger
  services when a message is sent; both `mail` and `logger` are optional.
- Built-in account emails can be translated into one site-wide language: pass an `@adonisjs/i18n`
  instance as `i18n` to `createMailNotifications` (resolved when each message is sent) or as the
  fourth argument of `renderAccountMessage`. Keys are `account_kit.emails.<kind>.<part>` and
  `account_kit.emails.copy_link`, each falling back to the English text. Output without `i18n` is
  unchanged.
- `adonisjs-account-kit/testing/notifications` captures notifications in application tests and
  returns the proof token from the latest link.
- `adonisjs-account-kit/ally` exports the Ally social provider adapter.
- The provider registers an `account_kit` container alias, typed through `ContainerBindings`, so
  `app.container.make('account_kit')` resolves the same `AccountKit` singleton.
- Doc comments on every public export, so the generated API reference describes each type,
  option and service method. Types the reference named but could not link are now exported as
  types only: `LucidModelRow`, `LucidUsersAdapter`, `LucidCreateAttributes`, `MessageLogger` and the
  `socialIntents`, `sensitivePurposes` and `socialProviderNames` lists behind the social union types
  from the package root, and `ExistingRoute`, `RoutePatternToken`, `ManagedSessionGuardOptions`,
  `ManagedTokenGuardOptions`, `ManagedSessionConfiguration`, `ManagedSessionStoreFactory` and
  `ManagedSocialExtension` from `adonisjs-account-kit/http`. No runtime export is added.
- Operator commands `account-kit:invite` and `account-kit:reset-link` (and the `kit.operator`
  services behind them) for shell-trusted invitations and reset links, with `--print` for
  printed links and JSON output.
- `account-kit:openapi` and `generateManagedOpenApi` produce an OpenAPI 3.1 document for the
  mounted managed routes; the `openapi` option of `registerManagedRoutes` carries schemas for
  replaced validators and account representations.
- `adonisjs-account-kit/adapters/drizzle`, `/adapters/prisma` and `/adapters/sql` adapt users
  tables defined with Drizzle, Prisma or plain SQL. They read the table definition and run every
  query through the package's Lucid transaction.
- The adapter contract checks that create, password, and registration-data writes roll back with
  the transaction, and that a password-less user never verifies.
- Tested on SQLite and PostgreSQL 16. MySQL 8.4 is experimental and uses the `mysql2` client with
  `timezone: 'Z'` and a UTC session time zone; see [compatibility](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/compatibility.md).
- Generated timestamp columns have millisecond precision, so MySQL does not round expiries and
  credential revisions to the second. Existing installations keep their columns.
- Managed route errors are translated through `@adonisjs/i18n` when the application uses it,
  as the official AdonisJS packages do: the message for code `X` is looked up as `errors.X` in
  the request's locale, with the English message as the fallback. `extensions.message` now
  receives the translated message as its default. The duplicate-email and password-policy 422
  messages are looked up as `validator.shared.messages.unique` and
  `validator.shared.messages.passwordPolicy`, the keys the VineJS messages provider reads.
  The password-reset and magic-link acknowledgements are looked up as
  `account_kit.password_reset_requested` and `account_kit.magic_link_requested`.
  `accountErrorResponse(error, { i18n })` looks up its message as `errors.<code>` the same way;
  the translator type is exported as `AccountKitTranslator`.
- Optional admission module (`adonisjs-account-kit/admission`, #518): after authentication and
  email verification, require an allowed email domain, invitation evidence and approval, each
  optional and cumulative. Adds `defineAdmission`, the `AccountAdmission` service and provider,
  `admissionMiddleware`, `withInvitationEvidence`, `withAdmissionCleanup`, the
  `account_admissions` migration stub, `AdmissionRequiredError` and `AdmissionDecisionError`.
  "Admission" now names this module; who may create an account is _registration availability_.
- Admission decisions (#518): `request`, `approve`, `reject`, `revoke` and cursor-paged `list` on
  `AccountAdmission`, `onAdmissionEvent`, and the commands `account-kit:admission:install`,
  `account-kit:admission:approve`, `account-kit:admission:revoke` and
  `account-kit:admission:grant-invitation` (export `adonisjs-account-kit/admission/commands`).
- `account-kit:admission:bootstrap <email> --role <role>` (#518): an operator invitation whose new
  account lands approved, with `--cancel`. Only the invitation it issued claims the approval. The
  `account_admissions` stub makes `user_id` nullable and adds `bootstrap_email`.
- Admission in the example application and guide (#518): `examples/api` gates `GET /api/v1/reports`
  on invitation and approval (and domain with `ACCOUNT_KIT_ADMISSION_DOMAINS`), with status,
  request and owner decision routes; invitation and export callbacks require an admitted owner.
  The packed consumer installs admission with `account-kit:admission:install`.

<details>
<summary>Pre-release candidate history</summary>

These entries record changes between unpublished candidates. They matter only to installations
that ran a candidate build.

### Added

- The developer evaluation record documents the four approved technical walkthrough tasks, outcomes, and evidence limits.
- The application-owned integration guide documents controller/service boundaries, HTTP error handling, and the agreed developer walkthrough protocol.
- `AccountKit.registration.register` (export) creates inactive accounts with trusted mapped fields, a durable activation proof, and uniform duplicate-email errors.
- `registration.availability` (required config key) selects open/closed/application admission and defaults to open in generated config; `registration.mapFields` (config key) selects trusted additional fields.
- Configured `registration.mapFields` now receives `undefined` when profile input is omitted, so required application fields can reject registration; mapped output must be a plain object.
- `passwordPolicy` (config key) applies Plus-style rules to newly established passwords with a 256-character service ceiling.
- The API example signup establishes a limited bearer token or browser session and denies protected access until verification.
- The maintained token API reference now documents bearer issuance, current-token logout, expiry, abilities, and application-owned route protection.
- Reference proof links now inspect on GET and complete on POST with no-store and no-referrer responses.
- The API reference now groups authentication and proof routes under `/api/v1/auth` and protected account routes under `/api/v1/account`; the previous `/account-kit` example paths have no aliases.
- The reference profile PATCH updates configured fields and pending email through the public profile operation, including inactive-address correction and credential revocation.
- Reference account errors now use stable JSON and JSON:API envelopes while Vine validation retains its 422 response.
- Bad-login errors in the API reference now return 401 with the same generic response for absent, wrong-password, restricted, and passwordless accounts.
- Optional managed Google and GitHub social endpoints provide provider redirects and callbacks, safe identity management, recent proof, and one-use PKCE handoff under the selected guard.
- Pillar-five setup records selected provider credential references and callback URLs, generates Ally wiring, and reports social activation and retirement prerequisites.
- Optional `adonisjs-account-kit/http` entry provides explicitly registered managed JSON routes, selected-guard adapters, route exclusions, validators, safe responses, and shared protection for application-owned routes.
- `account-kit:setup` (command) previews, validates, applies, replays, and diagnoses six-pillar onboarding choices in `config/account_kit_setup.json` (file).
- The API example adds application-owned Google and GitHub social routes for both selected guards, with client and session PKCE handoff, required-field continuation, proof-protected linking, and account methods.
- Phase 2 social identity proceeds under decision D06 (issue #14), which approves the Google and GitHub providers; issue #57 tracks the phase. Phase 2 remains separately released from Phase 1.
- Optional Google and GitHub social identity services add safe linking, provider email verification, recent proof, relationship notices, and one-time PKCE handoff.
- `socialAuthentication.unlink` is a credential change with the `social_unlink` operation: it advances the credential revision in the unlink transaction, ending sessions and tokens established through the removed provider (and the caller's own), and runs `onCredentialsChangedTransaction` and `onCredentialsChanged`.
- Provider-only recent proof requires separately verified authentication-time evidence; the maintained Google and GitHub Ally adapters do not supply it, so social-only accounts use password reset followed by password re-entry for sensitive changes.
- `AccountKit.authentication` adds named session or opaque-token login, failed-attempt limits, safe current-account access, and current-credential logout.
- `authentication.changeRestriction` records package-managed access-policy changes and revokes credentials through the selected guard policy.
- `users.credentials_changed_at` (column) invalidates existing browser sessions and login attempts using superseded account evidence.
- The API example provides session CSRF bootstrap, browser logout, and selected-guard access middleware for protected routes.
- The session reference makes CSRF bootstrap responses non-cacheable and documents browser setup and application-route revocation.
- Inactive accounts may correct an unconfirmed email through the limited credential gate while verified routes still reject them.
- The API example checks token abilities before sending invitations and returns `missing_ability` for a token without permission.
- Read-only activation and email-change proof inspection methods check current account state without consuming a link.
- `emailPasswordManagement.updateProfile` writes only mapped registration fields and optional pending email under one current-password-protected transaction.

- Maintained account email templates and AdonisJS Mail `sendLater` callbacks for action links and credential notices.
- Trusted configured-origin action links with base-path preservation and production HTTPS checks.
- Explicit `delivery` classification and notification readiness checks for transport, destinations, and application-owned durable delivery.
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

- Interactive setup now starts from valid saved choices, keeps applicable values when answers are blank, and explains when it falls back to safe defaults.
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
- `limiterSecret` accepts an AdonisJS `Secret` as well as a string, so the config passes
  `env.get('APP_KEY')` without `.release()`. The stub and examples do this.
- `onCredentialsChangedTransaction(user, context, trx)` is the transaction-aware credential
  revocation hook. It is mutually exclusive with the legacy post-commit
  `onCredentialsChanged(user, context)` hook.
- Password reset notification failures remain generic at the HTTP boundary. A failed post-commit effect
  can be reported with `committed: true`; the database transaction has already committed.
- Configure accepts `--users-table` and `--user-id-type` (`integer`, `string`, or `uuid`) for newly
  generated migrations. Existing generated config and migration files are not rewritten.

### Fixed

- Setup asks only mail and destination questions required by the selected email flows.
- Setup readiness checks resolve selected origin values from Adonis environment files while keeping process values first and reporting unsafe assignments without exposing their contents.
- Package archives exclude private planning and review documents while retaining public docs and examples.
- Installed-consumer upgrade checks preserve an outstanding password-reset proof through the table rename and verify one-time redemption.
- Minimum-consumer diagnostic markers use the current password-reset and email-verification vocabulary.
- Email-change requests and completions, invitation sends and invitation acceptance now run their
  notices, link deliveries, legacy credential callbacks and lifecycle events when the transaction
  commits but connection cleanup or a commit listener then fails. The operation still reports
  `PostCommitError` with `committed: true`.
- Invitation resend and revoke now run their link delivery and lifecycle event after the same kind
  of committed cleanup fault, matching the other invitation operations.
- The Drizzle and Prisma users adapters now forward `delete`, so account deletion no longer fails
  with `users.delete must be a function`.

### Integration notes

- Registration attributes are untrusted. Applications must map only validated profile data in
  `mapRegistrationData`; identity, email, password, verification, and role fields remain controlled
  by the adapter and account operation.
- Enabled capabilities default to password reset, email verification, and email/password
  management; registration and invitations require explicit opt-in. When supplying a subset, configure only the
  callbacks required by those capabilities; calling a disabled operation fails explicitly.
- Current evidence is tracked in [verification](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/maintainers/verification.md).

</details>
