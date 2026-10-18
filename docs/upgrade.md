# Upgrade guide

This guide is for applications that installed a pre-release candidate build. New installations can
skip it and start with [getting started](getting-started.md).

This candidate changes adapter setup, configuration requirements, callback timing, invitation
pagination, registration mapping, and generated schema. Review each item before replacing the
installed package. Configure deliberately skips existing config and migration files; it does not
rewrite them to match new options or schemas.

## Configuration

The supported runtime, framework, database, and schema points are listed in
[compatibility](compatibility.md). The declared package peer ranges are wider than the versions
tested at their boundaries; use the tested versions when planning a production upgrade. The
supported databases are PostgreSQL and SQLite on the configured Lucid connection, with integer,
string, or UUID user keys and the schema constraints described by
[identity creation](identity-creation.md). Other runtimes, databases, and schema layouts are not
claimed by this guide.

Setup's automatic Lucid model inspection is limited to a contained `#models/user` mapping that
resolves to a direct `BaseModel` class or the stock `UserSchema`/`withAuthFinder` composition. Import
aliases must resolve to files setup inspects. It checks the effective model, including inherited and
overridden column decorators, for one physical `id` primary column with the selected TypeScript ID
type. Custom class decorators, constructors, decorated accessors, runtime metadata hooks, or other
dynamic class initialization require manual reconciliation before generating matching migrations;
static inspection cannot establish the model metadata produced at application boot.

Before applying migrations, confirm the final physical user table shown in setup's preview, whether
it comes from an explicit choice or the selected default, matches the application's model and the
generated migration targets. Custom user classes or dynamic metadata outside the supported static
inspection need manual reconciliation; setup does not certify the model produced at application
boot.

The setup command needs the optional TypeScript parser to inspect application source: TypeScript
5.9.3 or newer in major version 5, or 6.0.3 or newer in major version 6. Install it for setup with
`pnpm add -D typescript@^5.9.3` (or `pnpm add -D typescript@^6.0.3`). Setup loads the parser lazily;
other Account Kit entry points do not require it. Run setup preview and `--check --production` in a
source, development, or CI environment before pruning production development dependencies. A
compiled deployment without the parser or source configuration is not a supported setup-check
environment.

Before the maintenance window, confirm that every instance has the required configuration, URL
callbacks, notifications for enabled features, selected guard, session store, and provider
credentials. Custom notification transport requires the callbacks for selected features; invitation
support also requires `invitationProvision`. See [operations](operations.md) for the complete
callback list, development capture limits, and shared-store and rotation behavior.

Setup defaults the trusted frontend-origin environment-variable name to `FRONTEND_URL`; you may
select another name. In production, both public backend and frontend origins must resolve to HTTPS.
Environment-variable names and callback-file presence do not prove that the values or callback
contracts are valid at runtime.

If `@adonisjs/limiter` is missing, run `pnpm add @adonisjs/limiter` followed by
`pnpm exec node ace configure @adonisjs/limiter`; then verify its provider is registered and
`config/limiter.ts` uses `defineConfig` with the selected configured store. Package installation
alone does not configure the runtime limiter. Any setup selection with authentication also requires
an application-owned `accountKitPolicy.canAccess(user, trx)` callback that enforces the real
restricted-account policy. Invitation support additionally requires `authorize` and
`onInvitationAccepted`; setup does not supply an allow-all policy.

Setup blocks apply when the selected database client is unknown or unsupported. For maintained
Mail, a missing selected mailer, plainly non-callable provider, or unsafe configuration also blocks
writes. An opaque factory requires manual verification of its configuration and delivery; even a recognized
transport remains unverified until its configuration and delivery are checked in the deployed
environment.

Session authentication requires a server-side session store; cookie-only sessions are rejected
because they cannot enforce logout replay protection. Managed session authentication also requires
`protectManagedSessionConfig` around the selected provider in `config/session.ts`, before
SessionMiddleware starts. Its `verifyStore(actual)` callback must attest central revocation for the
actual selected store; a method named `destroy` alone is not proof. The wrapper rejects cookie-backed
stores, including aliases and subclasses. Setup generates the wrapper only for conventional
`defineConfig` session configuration and recognizes its inspected database or development-memory
selection; static inspection does not prove actual revocation behavior. Database sessions require
the application session-table migration and a verified applied table; memory sessions are not
acceptable in production, which requires persistent shared storage. Custom or dynamic syntax gets a
blocking setup diagnostic for `account-kit:setup --apply`. Convert it to the supported conventional
shape to use automated setup. If retaining custom syntax, manually integrate the public wrapper and
an application-owned verifier against the actual selected store, then manage the remaining setup
changes separately; a method-shape check alone is insufficient. Exercise logout replay after either
path.

Enable Shield CSRF verification for session requests and retain the BodyParser, session, Shield,
then auth middleware order. Setup can inspect known Shield and session configuration but cannot
prove environment-dependent settings resolve correctly at runtime. Session clients fetch the managed
CSRF bootstrap endpoint only after the managed route mount is active. While
`authentication.applicationRouteRevocation` is false, expose an application-owned CSRF bootstrap
route as described in the [revocation bootstrap procedure](setup.md#prove-revocation-before-route-activation);
keep an application-owned replacement if `auth.csrf` is excluded. Retain the session cookie and send
the returned token in `x-csrf-token` on state-changing requests. Managed handlers fail closed if
Shield has not established CSRF state. Setup places `account_kit_proof_headers_middleware` first in
`server.use`, before BodyParser or other middleware that can terminate a proof request; retain that
order. An excluded or application-owned proof route needs equivalent early response headers,
including on parser and CSRF failures. See [authentication](authentication.md),
[managed HTTP](managed-http.md), and [setup](setup.md).

Managed routes default `verificationRequired` to `true`; setup also generates
`managedAccountMiddleware` for application-owned protected routes. Keep it on routes requiring
verified-account or credential-revision checks, and use the same `active` setting on managed and
application-owned routes if verification is optional. Direct database writes to account identity,
proof state, restrictions, or provider associations bypass related invalidation and revocation.

## How it works

### Deployment boundary

Use a maintenance window with no old/new version overlap. Do not use a rolling deployment. Stop old
web instances, scheduled commands, and application-owned workers first; take and verify a
restorable full database backup; apply the reviewed migrations; then start the new version and its
workers. Send traffic to the new version only after migrations and configuration checks succeed.
This prevents old code from writing against renamed or evolved tables.

Preserving outstanding one-use proof rows preserves those proofs through migration. Legacy
encrypted repeatable activation links use another format and must be reissued as one-use proofs
during the identity migration. Do not remove proof rows as a general upgrade step.

### Rollback boundary

Use a maintenance window with no old/new version overlap for rollback as well as upgrade. Stopping
the new version before its first application write is necessary, but it does not make every
migration reversible. The retirement migration's `down()` recreates `account_email_changes` empty;
the identity evolution migration's `down()` drops transferred email-verification proofs, does not
restore the previous email for inactive users, and leaves passwords nullable. Reversing those
migrations can therefore lose or alter pre-upgrade data even when the new application has written
nothing.

Prefer forward recovery. If restoring the old version is required, restore and verify the complete
database backup made immediately before migration, along with the matching application
configuration, then start the old version after confirming no new-version instances or workers
remain. Reconcile any writes made since that backup separately. Do not rely on migration `down()`
methods to recover the old data state or describe schema rollback as a data-compatible downgrade.

### Credential compatibility during upgrade

Sessions created before this integration carry no Account Kit credential revision. The managed
session guard rejects them; users must complete the package-aware login flow to establish a revised
session. A session that already has a valid revision can continue only while its session remains
available in the selected server-side store and its signing/configuration settings remain compatible.
Changing or losing the store, session keys, or related configuration can invalidate existing
sessions. Coordinate those changes with the upgrade and expect affected users to sign in again.

Existing bearer tokens remain usable only when native AdonisJS authentication accepts them and
their rows remain in `authentication.tokenTable` in `config/account_kit.ts`. A missing, revoked, or differently
selected token table makes those credentials fail. Account Kit credential-changing operations
revoke a user's token rows in that configured table; preserve the rows only when the application's
token policy intends the existing credentials to remain valid. Changing the token table or native
authentication configuration can therefore invalidate existing tokens. Framework key rotation
may affect session cookies, while Account Kit proof tokens are stored as hashes and do not depend on
`APP_KEY`; see [operations](operations.md#secret-rotation) for the separate limiter and proof
rotation behavior.

During deployment verification, exercise an already-enrolled session, a pre-integration session
that must log in again, a bearer token whose row is preserved in the selected table, and a token
whose row was revoked or removed. Also verify behavior after any planned session-store, token-table,
key, or authentication-configuration change before sending production traffic.

### Setup apply limits

Setup previews by default and does not install dependencies or run migrations. Review generated
files and migrations, resolve blocking diagnostics, then apply and run migrations as separate
steps. Apply uses an exclusive `.account-kit-setup.lock` to coordinate setup runs; it does not lock
arbitrary editors or make filesystem changes atomic. Stop other editors and setup processes in that
workspace while applying. Setup checks planned files before and during writes, skips identical
files, and records choices last. An interruption can leave some files in place; inspect the lock
and current files, then rerun with the same choices to recover. See [setup](setup.md) for the full
recovery contract.

The setup source check inspects TypeScript without executing application configuration. It resolves
the selected direct `DB_CONNECTION` and `SESSION_DRIVER` selectors from process environment first,
then the application's environment files in Adonis loading order. It accepts a direct store name;
interpolation, malformed or duplicate assignments, linked files, unresolved selections, and
unsupported dynamic config expressions block automatic apply and require manual reconciliation.
Do not use a source check on a compiled, pruned server to claim that missing TypeScript or source
configuration was validated. Verify the actual deployed environment and selected stores separately.

Setup's route inspection checks literal routes in `start/routes.ts` against selected managed
methods and paths. It does not boot the application; grouped, imported, or programmatically
generated routes cannot be certified by that static check. The package checks the committed Adonis
route graph during application boot, so perform that boot check and exercise selected endpoints
before treating route integration as verified.

### Managed route replacements and readiness

Persist endpoint exclusions in the setup choices' `managedExcept` list; do not hand-edit the
generated route mount. Add an application-owned replacement with the same method and path. That
route owns validation, response mapping, authentication, and CSRF behavior. If a manual edit already
exists, reconcile it with a clean generated mount; setup preserves the edit as a conflict until
resolved. Check the route plan for method/path collisions, then verify the runtime route graph at
boot.

Treat readiness fields separately. `configurationValid` is static configuration evidence and does
not certify the executable route graph. `migrationsApplied`, `workflowVerified`, and
`productionReady` are not proven by setup; `externalConfigured` is a static assessment, not proof
that SMTP, provider credentials, session revocation, callback contracts, or a live workflow
succeeds. Application-owned policy and notification files can exist while their callback contracts
remain unverified. Run migrations and verify the selected session store, external integrations, and
account workflows in the target environment before declaring production ready.

Leave `authentication.applicationRouteRevocation` false for the first apply. Setup generates the
guard and account-access middleware with an inert `start/account_kit_routes.ts`; no managed routes
are registered and the endpoint inventory is empty. After reviewing and running the generated
migrations, attach the middleware to a temporary protected application route and follow the
[capability-aware revocation bootstrap procedure](setup.md#prove-revocation-before-route-activation).
Establish the original credential through package-aware login and the generated guard; native guard
login or `loginAs` alone does not enroll the package credential revision. Use the public revocation
operation available to the selected capabilities: change the password when
`emailPasswordManagement` is selected, complete a delivered reset when only `passwordReset` is
selected, or restrict then restore the account when authentication alone is selected. For the
restriction path, prove access succeeds again with a fresh credential after restoration, then prove
the original credential still receives 401. In every path, an initial success and a post-change
denial of the same credential are required; denial only while the account remains restricted is not
proof of revocation. Register the generated access-middleware class from
`app/middleware/account_kit_access_middleware.ts` in the `start/kernel.ts` named map and apply its
`handle` implementation to the route. Remove or secure the temporary test route before production.
Only then set `authentication.applicationRouteRevocation` to true and rerun setup to activate the
managed route mount. Setup does not ingest runtime results and always reports `workflowVerified` as
false; record the operator's workflow evidence separately.

### Retiring password login

Removing authentication configuration runs a read-only, point-in-time inventory over configured
user IDs and each adapter's `hasPassword` result. It does not inspect provider identities or prove an
alternative login is usable. Accounts with passwords block apply until credentials are migrated; a
zero count still requires `--retirement-maintenance-window`. This flag records the operator's
assertion; it does not stop writes. Run inventory and apply in a real maintenance window that
prevents concurrent credential changes, after independently confirming a usable alternative for
every affected account. Do not rely on the stale scan alone.

## Identity creation and proof migration

Follow the [identity creation contract](identity-creation.md), especially its manual steps,
before applying the appended migrations. Custom adapters now accept explicit pending-email and
nullable-password creation attributes, expose `AccountUser.unverifiedEmail`, and implement
`setUnverifiedEmail`. The API example has been updated to the new contract.
Enable and configure registration explicitly as described in [registration](registration.md).
An inactive activation now needs `emailVerification.complete({ token, password })`; update clients
to POST a fresh password and confirmation. Token-only activation attempts fail. Existing legacy
activation links must be reissued after the proof migration. A successful claim replaces an
earlier password and invalidates credentials issued for the inactive account. Existing
application-owned signup routes should establish only a limited credential and enforce
`unverified_email` on protected routes.
Custom adapters enabled for email verification now need `setPassword`, even when they do not
change confirmed email addresses. Configured registration field mapping runs on omitted input;
required profile fields can therefore fail before account creation. The basic
`pnpm exec node ace configure adonisjs-account-kit` starter stub omits invitations. Setup-generated
configuration includes invitations only when selected and includes the policy callbacks for that
selection; change the setup choices and rerun setup instead of hand-editing setup-owned config.
Runtime configuration also leaves invitations disabled when `enabled` is omitted, so enable
invitations explicitly if the application uses them.
Custom `markEmailVerified` implementations must clear the pending address in the same transaction
as the audit timestamp; otherwise an inactive account will not activate. Password reset and
password change also call `setUnverifiedEmail` to cancel a distinct pending address.
Existing migrations are preserved; review the generated evolution, social-identity and retirement migrations against
the application-owned users table. Existing reset proofs and pending email-change proofs are
transferred. Encrypted repeatable activation links must be reissued. Do not infer provider
ownership from an email match when migrating application social identities.

## Vocabulary alignment

D24 permits breaking contract changes before first publication, with no compatibility layer.
Apply the [Unreleased rename list](../CHANGELOG.md#unreleased) to service calls, input imports,
capability values, URL/notification callbacks, expiry configuration and lifecycle listeners.
Replace `ttl` with `expiresIn`, using `passwordReset` and `emailVerification` inside it; existing
string lifetimes retain their meaning and positive numeric values represent seconds. Keep
credential-revocation hooks and all `E_ACCOUNT_KIT_*` error codes unchanged.

The reset-token table changes from `account_recovery_tokens` to `password_reset_tokens`.
For an existing installation, configure preserves the old applied migration and may generate a
new `*_account_kit_create_password_reset_tokens.ts`. Before running it, replace that new file's
create/drop operations with the following application-owned rename migration. Do not edit an
already-applied migration or create a second empty reset-token table:

```ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.renameTable('account_recovery_tokens', 'password_reset_tokens')
  }

  async down() {
    this.schema.renameTable('password_reset_tokens', 'account_recovery_tokens')
  }
}
```

Use a maintenance window so old and new package versions do not access different table names.
Preserve every existing column and row, including hashes, expiry timestamps and outstanding
proofs. Apply the rename before starting the new application code; restore the old code with the
reverse table rename if rolling back. Fresh installations use the generated create-table migration.
The later identity migration changes the email-change table, verification state, token columns,
and secret length as described above; default lifetimes remain unchanged.

## Manual steps

### Existing installations

1. Build and install the candidate tarball using the package's normal pnpm workflow. Keep a copy of
   the current application-owned config and migrations for review.
2. Run `pnpm exec node ace configure adonisjs-account-kit`. Existing config is preserved. Existing
   migration files with recognized names are skipped; configure creates only missing migrations,
   including `create_account_transaction_lock`. For an older reset-token table, apply the
   vocabulary migration instructions above instead of running the generated create-table operation.
3. Compare the preserved `config/account_kit.ts` with the current generated stub and update it
   manually. Add the required `limiterSecret`, preferably the stable `APP_KEY`; update callbacks,
   adapter construction, and capability configuration as needed.
4. Update the application-owned HTTP integration after installing the candidate. Adopt the new
   `accountErrorResponse` export in the central exception handler and update pagination consumers
   and password reset failure handling. The upgrade fixture keeps its baseline-compatible handler until
   this explicit integration step.
5. Review generated migrations against the application schema. Take and verify a restorable full
   database backup, then run migrations in a controlled deployment; the rollback boundary above
   depends on that backup. The package cannot rewrite already-applied schema.
6. Typecheck and run package-specific consumer tests before deployment. Verify that the limiter
   secret and namespace are consistent across application instances.

Every credential change deletes rows from `account_sessions` when `authentication` is configured,
whether or not `sessionManagement` is enabled. Run configure to generate `create_account_sessions`
and apply it before deploying this version; until then, credential changes fail.
`account-kit:doctor` reports the table as missing. Enabling `sessionManagement` with the session
strategy signs every user out once. Custom guard adapters receive an extra `establish` argument
(see [signed-in devices](signed-in-devices.md)), and exhaustive switches over `Capability`,
`CredentialOperation` or `LifecycleEvent` need the new members.

SQLite package writes require the new `account_transaction_lock` table. Apply its migration before
deploying code that uses the new transaction path. The table is package-owned and independent of
application user rows.

### Invitation listing index

New invitation migrations create `account_invitations_created_at_id_expires_at_index` on
`(created_at, id, expires_at)`. Configure preserves existing migrations, so installations created
with an earlier invitation migration need a new application-owned migration to add this index.
Do not edit an already-applied migration. After confirming the index is absent, add:

```ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('account_invitations', (table) => {
      table.index(
        ['created_at', 'id', 'expires_at'],
        'account_invitations_created_at_id_expires_at_index'
      )
    })
  }

  async down() {
    this.schema.alterTable('account_invitations', (table) => {
      table.dropIndex(
        ['created_at', 'id', 'expires_at'],
        'account_invitations_created_at_id_expires_at_index'
      )
    })
  }
}
```

This index supports creation-order pagination without sorting the entire table. Expiry remains a
filter, so a page can still scan many expired entries; keep the expired-invitation pruning job
running as described in [operations](operations.md). Page size caps the returned data, not the
number of database entries examined.

### Breaking contract updates

- **Limiter secret is required.** `limiterSecret` must be a stable string of at least 32 bytes. Use
  a secret shared among instances using the same limiter store. Changing it resets the HMAC-derived
  limiter buckets. `limiterNamespace` separates applications sharing the same secret/store.
- **Lucid adapter setup changed.** Replace copied adapter code with the maintained adapter only
  after installing the candidate tarball that exports it. Use
  `createLucidAdapter(async () => (await import('#models/user')).default, options)`. It derives the
  physical table and validates the default connection and `id` primary key. It uses model save hooks
  to hash passwords.
- **Registration data is explicit.** Invitation acceptance can pass `registrationData` to
  `UsersAdapter.create`. The Lucid adapter does not spread it onto the model. Implement a trusted
  `mapRegistrationData(data, user)` that validates and copies allowed profile fields. Do not let
  request data assign identity, email, password, verification state, or role.
- **Invitation listing is paged.** `invitations.list({ actorId, limit?, cursor? })` returns
  `{ items, nextCursor }`, defaults to 25 items, and accepts at most 100. Update controllers and
  clients that previously expected a complete unpaged collection.
- **Capabilities can be disabled explicitly.** `enabled` defaults to password reset, email
  verification, and email/password management; registration and invitations require explicit opt-in.
  A configured subset only requires callbacks for enabled features. Calling a disabled operation
  rejects with `CapabilityDisabledError`.
- **Credential revocation can be transactional.** Prefer
  `onCredentialsChangedTransaction(user, context, trx)` when revocations must commit atomically.
  It is mutually exclusive with `onCredentialsChanged(user, context)`, the legacy post-commit hook.
  Dedicated `notify.passwordResetCompleted` and `notify.passwordChanged` callbacks cover user notices.
- **Lifecycle callbacks expose identifiers.** `onLifecycleEvent` receives safe event names and
  IDs after commit. Tokens, addresses, and notification URLs are excluded. A durable consumer must
  persist an outbox record inside the relevant transaction.
- **Post-commit failure means committed state.** `PostCommitError.committed` is `true`; do not treat
  it as a rollback or blindly repeat the mutation. Password reset request handlers must suppress both
  `DeliveryError` and `PostCommitError` and return the generic acknowledgement.
- **HTTP error contracts use package metadata.** Map `E_ACCOUNT_KIT_*` codes and status centrally.
  Missing and denied invitation-management requests use the same not-found code/body. Do not expose
  internal causes or callback errors.

## Custom user table or ID type

See [custom user table or ID type](custom-schema.md).

## Application behavior to revisit

Account Kit does not universally terminate browser sessions or remove team memberships. Wire
application-owned API token revocation through the transactional credential hook, and implement
browser-session or tenant membership policy in the application where required. Expired token
cleanup is an explicit Ace command, not an automatic scheduler. See
[operations](operations.md) for safe pruning and durable notification guidance.

The full route and validation example is in [`examples/api`](../examples/api/README.md). Current
tested versions and remaining verification are in [compatibility](compatibility.md) and
[verification](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/maintainers/verification.md).

## Files delta

The candidate adds the maintained Lucid adapter and optional managed HTTP integration, and changes
the generated schema for pending email, verification proofs, token columns, and SQLite transaction
locking. Configure preserves existing application config and applied migrations; review generated
files against the application schema and update application-owned routes, callbacks, session
protection, and workers as described above.

## Changelog

Review the repository's [Unreleased changelog](../CHANGELOG.md#unreleased) for the full API,
configuration, schema, and behavior changes. In particular, account for renamed password-reset and
email-verification operations, the inactive-account claim flow requiring a fresh password, and the
new credential-revision behavior before upgrading clients or deploying the candidate.
