# adonisjs-account-kit

Forgot password, email verification, invitations, and email and password management for AdonisJS 7. The
application owns its user model, HTTP routes, validation, password policy, and notification
delivery. The package provides transactional account operations and callbacks for application
authorization and side effects.

Account Kit covers the account basics and uses the same vocabulary as AdonisJS Plus and the
AdonisJS starter kits. For two-factor authentication and passkeys, we recommend
[AdonisJS Plus](https://plus.adonisjs.com).

## Requirements and installation

Use Node.js 24 or newer and pnpm. The package is currently an unpublished `0.0.0` candidate; install
the tarball produced by the repository build:

```sh
# In this repository
pnpm build
pnpm pack --pack-destination /tmp

# In the AdonisJS API application
pnpm exec node ace add @adonisjs/limiter
pnpm add /tmp/adonisjs-account-kit-0.0.0.tgz
pnpm exec node ace configure adonisjs-account-kit
```

The application must provide compatible AdonisJS core, Lucid, limiter, Luxon, and the database
driver for its selected Lucid dialect. PostgreSQL applications install `pg`; the Adonis API kit's
SQLite setup uses `better-sqlite3`. See [compatibility](docs/compatibility.md) for tested version
points and declared peer ranges.

Configure creates `config/account_kit.ts` when absent, registers the provider, and generates nine
package migrations for a fresh install when matching files do not already exist. It preserves
existing configuration and migrations. Review generated files, set a stable `APP_KEY` and
`APP_URL`, then apply migrations and typecheck:

```sh
pnpm exec node ace migration:run
pnpm typecheck
```

## Quick start

The maintained API consumer fixture is the runnable setup and operation example. Run its packed
consumer gate from this repository to build the candidate tarball, install it into a copy of the
fixture, run configure, and exercise the installed package:

```sh
pnpm test:consumer
```

The fixture's invitation-list action shows an operation in its application context, after
authentication and request validation:

```ts
const result = await (
  await this.kit()
).invitations.list({
  actorId: actor.id,
  limit,
  cursor,
})
return response.ok(result)
```

For application setup, including the lazy Lucid adapter, trusted registration mapping, required
callbacks, and HTTP error handling, follow the [consumer API example](examples/api/README.md) and
its [Account Kit config](examples/api/config/account_kit.ts). The [application-owned integration
guide](docs/application-owned-integration.md) explains the controller, route, validation, response,
notification, and authentication boundaries. Treat `registrationData` as untrusted request data;
the example maps a validated name and never spreads request fields onto the model.

## Application prerequisites

- The user model exposes `id` → `id`, `email` → `email`, nullable `unverifiedEmail` →
  `unverified_email`, nullable `password` → `password`, and nullable `emailVerifiedAt` →
  `email_verified_at`. A null password represents an account without local credentials; a new
  inactive account writes the same normalized address to `email` and `unverified_email`. `id` is
  the physical primary-key column. Models that assign string/UUID keys must enable Lucid’s
  `selfAssignPrimaryKey` policy; see the custom schema guide.
- Email is stored trimmed and lowercase, and has a single-column unique constraint. The Lucid
  adapter compares normalized email values with indexed equality. PostgreSQL duplicate-email
  classification discovers the table's single-column email unique index through the catalog;
  optionally set `emailConstraint` to select a particular index. Existing mixed-case or padded
  addresses must be normalized before enabling the adapter.
- The adapter derives the Lucid table and primary key and requires the default connection. For a
  hand-written adapter, expose `resolveMetadata()` with the physical table and `primaryKey: 'id'`,
  or set `usersTable` as the metadata fallback. The package locks that physical user row on
  PostgreSQL and serializes package writes through its singleton lock row on SQLite. Duplicate
  email races are classified using the PostgreSQL catalog unless `emailConstraint` is supplied.
- `APP_KEY` must be stable across restarts and at least 32 bytes. Account Kit derives namespaced
  HMAC limiter keys from this secret. Changing it resets those limiter buckets; use the same secret
  and `limiterNamespace` across application instances that share a limiter store.
- `APP_URL` must be the application's public HTTPS base URL. Generated URLs preserve a configured
  path; do not construct account links from an untrusted `Host` header.
- Derive password reset `clientKey` from the request IP only after configuring Adonis trusted proxies.
  Never trust a caller-supplied key or an unverified `X-Forwarded-For` value.
- SQLite applications must enable foreign keys on every connection and size the pool for their
  concurrency. Transaction callbacks must use the supplied `trx`; details are in
  [usage and transaction guidance](docs/usage.md#transactions-and-callbacks).

For a custom user table or string/UUID user IDs, pass `--users-table` and `--user-id-type` when
running configure, then inspect all generated migrations. See the
[custom schema instructions](docs/upgrade.md#custom-user-table-or-id-type).

## Operations and security

Account Kit owns its root write transactions. Do not wrap package write operations in an active
global transaction. Application validators remain responsible for request shape, password policy,
confirmation fields, and authorization at the HTTP boundary. Password reset requests must return a
generic acknowledgement even when post-commit notification delivery fails. The package's minimum
request duration mitigates timing differences; it is not a timing guarantee.

For capability configuration, operation signatures, pagination, error mapping, transaction
callbacks, outbox handling, and cleanup, see [usage](docs/usage.md) and
[operations](docs/operations.md). Breaking changes and migration steps are in the
[upgrade guide](docs/upgrade.md). Report suspected vulnerabilities using the process in
[SECURITY.md](SECURITY.md).

## Validation status

Version points and the current audit assessment are recorded in
[compatibility](docs/compatibility.md). Current repository checks and consumer validation belong
in the maintained [verification record](docs/verification.md); it distinguishes package tests,
packed-consumer checks, and checks that remain outstanding.
