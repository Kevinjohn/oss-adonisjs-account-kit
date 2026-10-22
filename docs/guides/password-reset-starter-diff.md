# API starter password-reset diff

This guide shows the focused changes made to a pinned AdonisJS API starter to add password reset
while keeping its original login route, user model, `/api/v1` namespace and `api` guard. It pairs
the [hand-edit patch](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf/docs/recipes/patches/api-password-reset.patch) with the complete generated-file
inventory [recorded below](#generated-files).
The [existing-application guide](password-reset-existing-app.md) explains the shared requirements and
the reset lifecycle.

## P1 starter record

The disposable application was created from the official API starter with:

```sh
pnpm create adonisjs@3.4.0 <directory> \
  --kit=github:adonisjs/starter-kits/api#46d235932e3eb6472a16b740fa0b47b5f69fc6fc \
  --pkg=pnpm
```

| P1 field                      | Recorded value                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creator                       | `create-adonisjs` `3.4.0`                                                                                                                                             |
| Starter                       | Official API starter revision `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`                                                                                              |
| Starter baseline commit       | `c1f74eadf5c11fb2f3bdb15e5063b39460ec7c62`                                                                                                                            |
| Configured checkpoint         | `909e473c899720eaea6c9cf0581baaecff0f142a`                                                                                                                            |
| Starter lockfile SHA-256      | `813bdffb59b9aad2e8cf7aedc26614fd6a2418be76b26c85f9897fa46d7470ad`                                                                                                    |
| Runtime and package manager   | Node `24.21.0`; pnpm `11.23.0`                                                                                                                                        |
| AdonisJS and database         | AdonisJS `7.6.0`; local SQLite `3.53.4`                                                                                                                               |
| Starter package.json versions | Runtime and development dependency ranges are listed below; the lockfile SHA-256 above pins the resolved starter tree.                                                |
| Account Kit archive           | Source and candidate revision `402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf`; package `0.1.1`; SHA-256 `fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227` |

The pinned starter's `package.json` recorded these dependency ranges:

```text
dependencies:
@adonisjs/auth ^10.1.0
@adonisjs/core ^7.5.2
@adonisjs/cors ^3.0.0
@adonisjs/lucid ^22.4.2
@adonisjs/session ^8.1.0
@adonisjs/shield ^9.0.0
@japa/api-client ^3.2.1
@tuyau/core ^1.2.2
@vinejs/vine ^4.4.0
better-sqlite3 ^13.0.3
luxon ^3.7.2
reflect-metadata ^0.2.2

devDependencies:
@adonisjs/assembler ^8.5.2
@adonisjs/eslint-config ^3.1.0
@adonisjs/prettier-config ^1.5.0
@adonisjs/tsconfig ^2.0.0
@japa/assert ^4.2.0
@japa/plugin-adonisjs ^5.2.0
@japa/runner ^5.3.0
@poppinss/ts-exec ^1.4.4
@types/luxon ^3.7.5
@types/node ~26.6.2
eslint ^10.11.0
hot-hook ^1.0.0
pino-pretty ^13.1.3
prettier ^3.9.9
typescript ~6.0.3
youch ^4.1.1
```

The fresh pinned starter passed `recipe_starter_login.spec.ts` before Account Kit configuration:
the original login reached its protected profile. The starter baseline was committed before
configuration. The generated inventory below records the tracked changes after the Limiter
prerequisite and `node ace configure adonisjs-account-kit`; the local `.env` file is ignored and
does not appear in that inventory.

## Generated files

These paths are the complete post-configure P1 `git status --porcelain` inventory. Limiter setup adds its
configuration, environment variables and migration. Archive installation changes the dependency
and lockfile; Account Kit configuration adds its provider, shared migrations and config. The `config/account_kit.ts` file is generated
first and then receives the hand edits shown in the next section. Generated migrations include
capabilities that are disabled in this reset-only setup; review them all and do not treat them as a
reset-only schema.

| Generated file                                                                      | What it provides                                                                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.env.example`                                                                      | Documents the generated environment values, including the selected limiter store.                                           |
| `adonisrc.ts`                                                                       | Registers the Account Kit provider and commands.                                                                            |
| `package.json`                                                                      | Adds configured package dependencies, including the Account Kit archive and Limiter.                                        |
| `pnpm-lock.yaml`                                                                    | Locks the installed package versions and archive dependency. It is generated setup output, not part of the hand-edit patch. |
| `start/env.ts`                                                                      | Validates the generated application and limiter environment variables.                                                      |
| `config/limiter.ts`                                                                 | Selects the configured Limiter store.                                                                                       |
| `start/limiter.ts`                                                                  | Registers Limiter middleware.                                                                                               |
| `database/migrations/1792695916977_create_rate_limits_table.ts`                     | Limiter's database-backed rate-limit table.                                                                                 |
| `config/account_kit.ts`                                                             | Generated Account Kit config; the hand edits below select reset, the existing guard, URL and local notification mode.       |
| `database/migrations/1792695917311_account_kit_add_account_columns_to_users.ts`     | Adds account columns to the existing users table and allows a nullable password.                                            |
| `database/migrations/1792695917312_account_kit_create_password_reset_tokens.ts`     | Stores password-reset proof hashes and expiry.                                                                              |
| `database/migrations/1792695917313_account_kit_create_email_verification_tokens.ts` | Shared email-verification proof table.                                                                                      |
| `database/migrations/1792695917314_account_kit_create_account_invitations.ts`       | Shared invitation table.                                                                                                    |
| `database/migrations/1792695917315_account_kit_create_account_transaction_lock.ts`  | Account transaction lock and initial singleton row.                                                                         |
| `database/migrations/1792695917316_account_kit_create_social_identities.ts`         | Shared social identity table.                                                                                               |
| `database/migrations/1792695917317_account_kit_create_social_transactions.ts`       | Shared social transaction table.                                                                                            |
| `database/migrations/1792695917318_account_kit_create_social_sensitive_proofs.ts`   | Shared social sensitive-proof table.                                                                                        |
| `database/migrations/1792695917319_account_kit_create_social_handoff_codes.ts`      | Shared social handoff-code table.                                                                                           |
| `database/migrations/1792695917320_account_kit_create_login_link_tokens.ts`         | Shared login-link table.                                                                                                    |
| `database/migrations/1792695917321_account_kit_create_account_sessions.ts`          | Shared account-session table.                                                                                               |

The package migration stubs define the precise columns, indexes, foreign keys and constraints. The
existing user table and access-token table remain application-owned. Limiter's rate-limit table is
a prerequisite for the configured database store.

## Hand edits

The patch changes five paths. One is generated config; the other four are new route or middleware
files, or a small registration in an existing file. The [unified patch](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf/docs/recipes/patches/api-password-reset.patch)
is the source for these before/after notes. Its SHA-256 is
`ecae3e6bdc2cf8f179e6ba27fe48fb81c5f8bfffd5a3cf14506db6e339ae3a0b`.

| File                                                     | Before                                                                                                                                                                      | After                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config/account_kit.ts`                                  | Generated config enables the wider capability set, points reset links at a recovery page, uses throwing notification callbacks and requires an application credential hook. | Selects `enabled: ['passwordReset']`; binds `access_tokens` to the existing `api` guard and `auth_access_tokens` table; points reset links to `/account-kit/auth/password-reset`; logs notifications for local development; leaves the transactional callback empty because this disposable API starter has no extra credential type to revoke. Keep the empty callback only when that is true for the real application. |
| `app/middleware/account_kit_proof_headers_middleware.ts` | No middleware applies managed proof-response headers to this new mount.                                                                                                     | Adds the managed proof-header middleware for `/account-kit`, the `access_tokens` strategy and password reset. This protects the proof response paths, including no-store and referrer policy headers.                                                                                                                                                                                                                    |
| `start/account_kit_routes.ts`                            | No Account Kit routes are mounted.                                                                                                                                          | Registers only managed password-reset routes below `/account-kit`, resolving the configured kit and existing `User` model through the `api` guard.                                                                                                                                                                                                                                                                       |
| `start/kernel.ts`                                        | Existing global middleware handles JSON responses, bindings and the starter's other concerns.                                                                               | Adds the proof-header middleware to the global stack so it runs for the managed reset endpoints.                                                                                                                                                                                                                                                                                                                         |
| `start/routes.ts`                                        | The starter's existing routes remain under `/api/v1`.                                                                                                                       | Imports the separate Account Kit route module after the existing route group. The login route and `/api/v1` namespace stay in place.                                                                                                                                                                                                                                                                                     |

The patch does not edit the generated `package.json`, lockfile, environment files or migrations. It
also does not replace the starter's `User` model or login controller. The package invalidates the
selected access tokens transactionally when reset completes; applications with other credential
types must revoke them through their own transaction hook.

## Application choices

This API composition chooses the existing `api` bearer guard and its `auth_access_tokens` table,
mounts only password reset at `/account-kit`, and keeps the starter's login and protected profile
routes under `/api/v1`. The sample's permissive `canAccess` callback and local log notifications
are disposable-development choices. Set the real account restriction policy and a production
notification transport in an application. Callback logging proves local invocation and exposes a
development proof; it does not deliver to a recipient inbox.

The shared configure command still generates the full Account Kit migration set. Inspect every
migration against the existing schema before running it. `enabled: ['passwordReset']` limits the
available capability; it does not prune migrations generated for other features.

The API example exercises HTTP contracts without a browser UI. Browser forms and their session
store, CSRF, revision middleware and recovery feedback belong to the stack-specific guides for
[Inertia React (#633)](https://github.com/Kevinjohn/oss-adonisjs-account-kit/issues/633),
[Inertia Vue (#634)](https://github.com/Kevinjohn/oss-adonisjs-account-kit/issues/634), and
[Hypermedia/Edge (#635)](https://github.com/Kevinjohn/oss-adonisjs-account-kit/issues/635).

## Focused evidence and limits

The full P6 recipe-harness run passed against source revision
`402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf` with a clean source tree and the archived package SHA-256
`fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`. It built and packed the
package, configured the pinned starter, and passed the named HTTP lifecycle test 1/1 in 2 seconds.
A second run using the same archive also passed 1/1 in 2 seconds; it reused that archive without
running build or pack. Both runs preserved the starter login/profile routes and listed exactly the
three managed password-reset routes. The default run's complete environment and command evidence
is in the [verified API recipe record](../recipes/password-reset-existing-login.md#clean-application-check).

The P7 dual-revocation mutation failed as expected: after credential revision advancement and
access-token deletion were both disabled, the test expected HTTP 401 but received 200. The exact
implementation bytes from the unchanged archive were restored, and the same focused test then
passed 1/1 in 2 seconds. This mutation evidence shows that the test detects credentials surviving reset; it does not
isolate the contribution of each revocation effect or establish broad mutation coverage.

The recorded environment is Node `24.21.0`, pnpm `11.23.0`, AdonisJS `7.6.0`, SQLite `3.53.4`,
and local in-process notification capture. This evidence does not establish PostgreSQL behavior,
recipient delivery, browser forms, viewports or keyboard acceptance. Browser-specific work is tracked
in the React, Vue and Hypermedia/Edge guides linked above.
