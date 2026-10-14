# Upgrade guide

This candidate changes adapter setup, configuration requirements, callback timing, invitation
pagination, registration mapping, and generated schema. Review each item before replacing the
installed package. Configure deliberately skips existing config and migration files; it does not
rewrite them to match new options or schemas.

## Existing installations

1. Build and install the candidate tarball using the package's normal pnpm workflow. Keep a copy of
   the current application-owned config and migrations for review.
2. Run `pnpm exec node ace configure adonisjs-account-kit`. Existing config is preserved. Existing
   migration files with recognized names are skipped; configure creates only missing migrations,
   including the new fifth migration `create_account_transaction_lock`.
3. Compare the preserved `config/account_kit.ts` with the current generated stub and update it
   manually. Add the required `limiterSecret`, preferably the stable `APP_KEY`; update callbacks,
   adapter construction, and capability configuration as needed.
4. Update the application-owned HTTP integration after installing the candidate. Adopt the new
   `accountErrorResponse` export in the central exception handler and update pagination consumers
   and recovery failure handling. The upgrade fixture keeps its baseline-compatible handler until
   this explicit integration step.
5. Review generated migrations against the application schema, then run migrations in a controlled
   deployment. The package cannot rewrite already-applied schema.
6. Typecheck and run package-specific consumer tests before deployment. Verify that the limiter
   secret and namespace are consistent across application instances.

SQLite package writes require the new `account_transaction_lock` table. Apply its migration before
deploying code that uses the new transaction path. The table is package-owned and independent of
application user rows.

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
  Dedicated `notify.passwordReset` and `notify.passwordChanged` callbacks cover user notices.
- **Lifecycle callbacks expose identifiers.** `onLifecycleEvent` receives safe event names and
  IDs after commit. Tokens, addresses, and notification URLs are excluded. A durable consumer must
  persist an outbox record inside the relevant transaction.
- **Post-commit failure means committed state.** `PostCommitError.committed` is `true`; do not treat
  it as a rollback or blindly repeat the mutation. Recovery request handlers must suppress both
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
its primary-key column and the default connection.

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
