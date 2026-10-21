# Identity creation contract

## Configuration

The application owns its user model and chooses the conventional Lucid adapter or a custom
`UsersAdapter`. The conventional mapping requires PostgreSQL 16, MySQL 8.4 or bundled SQLite on the
default connection, a physical `id` key (`integer`, `string`, or `uuid`), and a users table with
unique, normalized `email`, nullable `password`, nullable `unverified_email`, and nullable
`email_verified_at`. The application supplies the ordinary user columns, including `id` and
`email`; Account Kit's user migration adds only its account columns and makes `password` nullable.
Pass a custom users table and ID type to configure with `--users-table` and `--user-id-type`. Other
column names, composite keys, and secondary connections are unsupported by this contract,
including when a custom adapter is used.

`create({ email, unverifiedEmail, password, registrationData? }, trx)` accepts an explicit pending
address and a nullable local password. `registrationData` is passed only to the trusted application
mapping callback; request properties are never copied directly to the user model. Email-verification-only
adapters also implement `setPassword`, because inactive activation now replaces the password supplied
by an earlier registrant. `updateRegistrationData(id, mappedData, trx)` is required only when profile
updates include configured registration fields. The maintained Lucid adapter applies those fields
through the same trusted `mapRegistrationData` callback and rejects edits to controlled account
fields. Keep ID, password hash, verification state, and roles under trusted account policy. Configure
`tokenSecretLength` as 40 bytes by default (16–64 allowed). Existing expiry defaults remain one hour
for reset, activation, and email change, and seven days for invitations.

## User fields and identity state

The maintained Lucid mapping in [`adapters/lucid.ts`](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/adapters/lucid.ts)
uses these application user fields:

| Model property    | Database column     | Meaning                                                                                                                            |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | `id`                | Physical primary key; integer, string, or UUID.                                                                                    |
| `email`           | `email`             | Confirmed address, or the address held by an inactive account.                                                                     |
| `password`        | `password`          | Nullable local password hash; social-only accounts can have no password.                                                           |
| `unverifiedEmail` | `unverified_email`  | Pending address awaiting activation or email-change proof.                                                                         |
| `emailVerifiedAt` | `email_verified_at` | Last completed verification; it does not decide whether an account is active, but a null value means the address is not confirmed. |

An account is active when `unverified_email` differs from `email`. This includes
`unverified_email = null`: existing records with a null value are treated as active, regardless of
`email_verified_at`. A new inactive account stores the same normalized address in both `email` and
`unverified_email`; a verified or invited account has `unverified_email = null`. Do not infer current
verification status from `email_verified_at` alone. A confirmed address needs both: an active
account and a non-null `email_verified_at`. The admission domain requirement and the social
link and unlink security notices check for a confirmed address, so an active row with a null
`email_verified_at` fails domain admission with `reason: 'unverified'` and cannot fix that itself:
`emailVerification.send` reports `already_verified` for an active account.

## Fresh installation

Create the application's ordinary users table through its own migration, including `id`, unique
normalized `email`, and `password` (nullable if the application allows passwordless accounts). To
install and configure Account Kit, run `node ace add adonisjs-account-kit`; if the package is already
installed, run `node ace configure adonisjs-account-kit`. Configure generates `config/account_kit.ts`,
registers the provider and command, declares `APP_URL`, and creates migrations that are missing; it
does not create or replace the application users table. The package currently generates 11 migrations. Its
[`configure.ts` migration inventory](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/configure.ts)
lists them.

Run the generated migrations before using the selected services. The package-owned
`add_account_columns_to_users` migration adds nullable `email_verified_at`, `unverified_email`, and
`credentials_changed_at` columns, and makes the existing `password` column nullable. The other
migrations create the package tables for proofs, invitations, transaction locking, social identity
and authentication state. The [migration stubs](https://github.com/Kevinjohn/oss-adonisjs-account-kit/tree/main/stubs/migrations)
show their exact schema. New
registrations create an inactive account with matching `email` and `unverified_email`, then activate
it through the verification flow.

## Adding Account Kit to an existing users table

For an existing ordinary AdonisJS users table, first check that its ID type and `email`/`password`
columns match the configured Lucid mapping. `configure` adds the same package migrations described
above; its user migration alters the configured users table, so that table must already exist. It
adds the three nullable account columns and makes `password` nullable. It does not alter the `email`
column, normalize addresses, populate verification state, change application roles or model hooks,
or migrate any old proof table. Review the
[`add_account_columns_to_users` stub](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/stubs/migrations/add_account_columns_to_users.stub) before
running it.

Before enabling registration, activation, password reset, email change, or social flows, the
application owner must decide how existing account and verification data maps to this contract.
In particular, all existing rows with `unverified_email = null` are active under the current
contract. If legacy records include unverified accounts, setting the new column to null for every
row would make those records active. Inspect existing `email`, any verification flags or timestamps,
pending email changes, reset/activation proofs, and social identity records; choose and implement an
application-specific data change and proof-handling policy before enabling affected flows. Check
that chosen values obey your unique normalized email policy and that only the intended accounts
become active. Account Kit does not provide automatic backfills, legacy proof migration, column
renames, or an upgrade guarantee for unpublished package releases.

Use this owner checklist as application planning, not as a package migration command:

- Back up the database and confirm you can restore it.
- Inventory current account rows, email values, password state, verification fields, pending email
  changes, and outstanding proofs or social identities.
- Decide which existing rows should be active, which need activation, and how old proofs and linked
  identities will be handled. Set `email_verified_at` on active rows whose address you already
  trust; leave it null only where domain admission and social notices should treat the address as
  unconfirmed. Implement and review any data changes in the application.
- In a disposable copy, run the migrations and exercise the selected existing-user and new-user
  flows, including attempts to use old proofs. Roll out only after the observed results match the
  decision.

## How proofs and identities work

Activation and email-change proofs share `email_verification_tokens` but have distinct purposes.
Only a hash is stored. A resend within one minute preserves the live proof and acknowledgement; a
later resend or replacement invalidates the prior proof. Completion checks expiry, current address,
pending address and purpose under the user lock, then consumes the proof once in the transaction.
Password-reset proof rows remain in `password_reset_tokens`.

An inactive user's email change updates both addresses, sends a fresh activation message, and
supersedes an earlier activation proof. Its proof requires activation with a new password and cannot
complete through the active-account email-change operation. An active user's change leaves the
confirmed address in place until completion; requesting the confirmed address again cancels a
pending change. An active account's activation resend cannot replace its pending email-change proof;
an inactive account's resend replaces the older proof after the suppression window, and only the
latest can be used. Password change cancels a distinct pending change while leaving equal addresses
inactive. An email-bound password reset cancels a distinct pending change and activates an account
with equal addresses, preserving the previous reset behavior. Changing an inactive account's
confirmed address invokes the configured credential revocation hook in its transaction-aware or
post-commit form; post-commit delivery still runs if that observer fails.

The package-owned `social_identities` table stores provider and subject metadata, with a unique
`(provider, provider_user_id)` key and cascading user foreign key. It stores no provider access or
refresh credentials. Existing application social identities need an application-reviewed
subject-to-user mapping; email equality alone does not prove ownership. Social sign-in endpoints are
outside this contract.
