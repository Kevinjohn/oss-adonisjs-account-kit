# Upgrade guide

This candidate changes adapter setup, configuration requirements, callback timing, invitation
pagination, registration mapping, and generated schema. Review each item before replacing the
installed package. Configure deliberately skips existing config and migration files; it does not
rewrite them to match new options or schemas.

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
required profile fields can therefore fail before account creation. Generated setup config omits
invitations from its enabled capability list, so enable invitations explicitly if the application
uses them.
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

## Existing installations

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
5. Review generated migrations against the application schema, then run migrations in a controlled
   deployment. The package cannot rewrite already-applied schema.
6. Typecheck and run package-specific consumer tests before deployment. Verify that the limiter
   secret and namespace are consistent across application instances.

SQLite package writes require the new `account_transaction_lock` table. Apply its migration before
deploying code that uses the new transaction path. The table is package-owned and independent of
application user rows.

## Invitation listing index

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

## Breaking contract updates

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
- **Capabilities can be disabled explicitly.** `enabled` defaults to all supported capabilities.
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

For a new installation with a non-default table or key type, pass configure options, for example:

```sh
pnpm exec node ace configure adonisjs-account-kit --users-table=account_users --user-id-type=uuid
```

Supported ID types are `integer`, `string`, and `uuid`. Configure uses these values only when it
creates migration files. If recognized files already exist, they remain unchanged and must be
reviewed manually. Point `defineConfig` at `usersTable` for a custom adapter; the Lucid adapter
derives its table, so do not also set `usersTable` for it. The Lucid model must use physical `id` as
its primary-key column and the default connection. For application-assigned string or UUID keys,
set `static selfAssignPrimaryKey = true` and assign the key before insertion. Without that model
policy, SQLite can replace the in-memory key with its numeric rowid and subsequent refreshes fail.
The API fixture selects this policy for its string/UUID modes.

When changing an existing database, inspect foreign-key types and all migration references. Match
`user_id` and `inviter_id` columns to the actual user ID type. Ensure the email unique index covers
only the email column. PostgreSQL duplicate-email classification discovers the single-column email
unique index from the catalog. Set `emailConstraint` only when you need to select a particular
constraint/index explicitly.

## Application behavior to revisit

Account Kit does not universally terminate browser sessions or remove team memberships. Wire
application-owned API token revocation through the transactional credential hook, and implement
browser-session or tenant membership policy in the application where required. Expired token
cleanup is an explicit Ace command, not an automatic scheduler. See
[operations](operations.md) for safe pruning and durable notification guidance.

The full route and validation example is in [`examples/api`](../examples/api/README.md). Current
tested versions and remaining verification are in [compatibility](compatibility.md) and
[verification](verification.md).
