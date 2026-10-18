# Identity creation contract

## Configuration

The application owns its user model and chooses the conventional Lucid adapter or a custom
`UsersAdapter`. The conventional mapping requires PostgreSQL 16, MySQL 8.4 or bundled SQLite on the default
connection, a physical `id` key (`integer`, `string`, or `uuid`), and an application-owned users
table with unique, normalized `email`, nullable `password`, nullable `unverified_email`, and
nullable `email_verified_at`. Pass a custom users table and ID type to configure with
`--users-table` and `--user-id-type`. Other column names, composite keys, and secondary
connections are unsupported by this contract, including when a custom adapter is used.

`create({ email, unverifiedEmail, password, registrationData? }, trx)` accepts an explicit
pending address and a nullable local password. `registrationData` is passed only to the trusted
application mapping callback; request properties are never copied directly to the user model.
Email-verification-only adapters also implement `setPassword`, because inactive activation now
replaces the password supplied by an earlier registrant.
`updateRegistrationData(id, mappedData, trx)` is required only when profile updates include
configured registration fields. The maintained Lucid adapter applies those fields through the
same trusted `mapRegistrationData` callback and rejects edits to controlled account fields.
Keep ID, password hash, verification state, and roles under trusted account policy. Configure
`tokenSecretLength` as 40 bytes by default (16–64 allowed). Existing expiry defaults remain one
hour for reset, activation, and email change, and seven days for invitations.

## How it works

`email` is the confirmed address, or the pending address while an account is inactive.
`unverified_email` is the address awaiting proof. An account is active when that column is null
or differs from `email`. `email_verified_at` records the last completed verification and is not
an authorization signal. New inactive accounts write the same normalized address to both
columns. Social-only creation can set `password: null`; `hasPassword` then reports false.
Invitations create an already verified user with a null pending address.

Activation and email-change proofs share `email_verification_tokens` but have distinct purposes.
Only a hash is stored. A resend within one minute preserves the live proof and acknowledgement;
a later resend or replacement invalidates the prior proof. Completion checks
expiry, current address, pending address and purpose under the user lock, then consumes the proof
once in the transaction. Password-reset proof rows remain in `password_reset_tokens`.
An inactive user's email change updates both addresses, sends a fresh activation message, and
supersedes an earlier activation proof. Its proof requires activation with a new password and
cannot complete through the active-account email-change operation. An active user's change leaves
the confirmed address in place until completion; requesting
the confirmed address again cancels a pending change. An active account's activation resend
cannot replace its pending email-change proof; an inactive account's resend replaces the older
proof after the suppression window, and only the latest can be used. Password change cancels a distinct pending change while
leaving equal addresses inactive. An email-bound password reset cancels a distinct pending change
and activates an account with equal addresses, preserving the previous reset behavior. Changing
an inactive account's confirmed address invokes the configured credential revocation hook in its
transaction-aware or post-commit form; post-commit delivery still runs if that observer fails.

The package-owned `social_identities` table stores provider and subject metadata, with a unique
`(provider, provider_user_id)` key and cascading user foreign key. It stores no provider access
or refresh credentials. Existing application social identities need an application-reviewed
subject-to-user mapping; email equality alone does not prove ownership. Social sign-in endpoints
are outside this contract.

## Files delta

The public adapter types live in `src/types.ts`, the conventional mapping in
`adapters/lucid.ts`, and proof operations in `src/verification.ts`, `src/credentials.ts`, and
`src/password_reset.ts`. Configure appends three migrations: evolve user/proof state, create
social identities, then retire the old email-change table. The API example includes matching
migrations and model fields. Already-applied migration files are preserved.

## Manual steps

Before applying migrations, inspect the generated files and verify the existing users table,
ID type, unique normalized email policy, password hashing hook, and transaction-compatible
custom adapter. Configure does not inspect these application rules or activate managed
endpoints. Review existing pending email-change rows and application social identities; resolve
any proof whose recorded current email no longer matches its user. Back up the database and
apply the new migrations in order during a maintenance window. The migration backfills
`unverified_email` to null for rows with an audit timestamp and to `email` for rows without it,
renames reset proof columns in place, and transfers outstanding email-change proofs before
removing the old table. It never normalizes production addresses. A prior encrypted repeatable
activation link must be reissued as a one-use proof. Do not roll back across this migration with
outstanding new proofs; a reverse migration cannot reconstruct the earlier proof model.
The generated `down()` also leaves the password column nullable after rollback. An application
downgrade must account for existing passwordless users and explicitly review its own schema and
sign-in policy before requiring a password again.

Update custom adapters to the new create shape and pending-email setter, plus the
`AccountUser.unverifiedEmail` property. Update application-owned schema representations and
controllers to use the pending-email state for authorization rather than the audit timestamp.
Run both database suites and the installed-consumer checks before deployment.

## Changelog

See the [Unreleased entries](../CHANGELOG.md#unreleased) for every changed public contract,
table, and column.
