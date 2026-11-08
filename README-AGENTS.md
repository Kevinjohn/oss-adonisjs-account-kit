# Account Kit: notes for coding agents

This file helps an agent decide whether Account Kit fits an application and how to integrate it
without breaking its guarantees. People should start with the
[README](https://github.com/Kevinjohn/oss-adonisjs-account-kit#readme). Links point at the
repository so they work from `node_modules` too.

## Fit check

Use it when all of these hold:

- AdonisJS 7 on Node.js 24 or later.
- Users sign in with an email address (password, magic link or Google/GitHub through Ally).
- The application already has, or will have, its own users table and model.
- The database is SQLite or PostgreSQL. MySQL support is experimental.

Do not use it for two-factor authentication or passkeys (AdonisJS Plus covers those), for
username-only accounts, or as an identity provider for other applications.

## Requirements

| Need              | Detail                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Peer dependencies | `@adonisjs/core` 7, `@adonisjs/lucid` 22.4+, `@adonisjs/limiter` 3, `luxon` 3                                                                                                                                                     |
| Optional peers    | `@adonisjs/mail` 10 (built-in emails), `@adonisjs/session` 8 (session login), `@vinejs/vine` 4 (managed routes)                                                                                                                   |
| Environment       | `APP_KEY` of at least 32 bytes, identical on every instance; `APP_URL`, HTTPS in production                                                                                                                                       |
| Users table       | `email` (unique, stored trimmed and lowercase), `password`, `unverified_email`, `email_verified_at`; `credentials_changed_at` when login is enabled                                                                               |
| Session login     | A server-side session store (database or Redis). The cookie store is not supported: a copied cookie keeps working after logout. Managed routes reject it; application-owned routes must configure a server-side store themselves. |

## Install

```sh
node ace add @adonisjs/limiter
pnpm add https://github.com/Kevinjohn/oss-adonisjs-account-kit/releases/download/v0.3.3/kevinjohn-adonisjs-account-kit-0.3.3.tgz
node ace configure @kevinjohn/adonisjs-account-kit
node ace migration:run
node ace account-kit:doctor
```

`node ace configure` writes `config/account_kit.ts`, generates migrations and registers the
provider and commands. `account-kit:doctor` exits 1 and names the fix when the config, limiter, `APP_URL` or
tables are wrong. The generated `notify` callbacks throw until email is configured.

## Capabilities

Set capabilities in `enabled` in `config/account_kit.ts`. Each one needs the adapter methods and
hooks listed in `src/capabilities.ts`; configuration fails at boot when one is missing.

| Capability                | Default | Service namespace             |
| ------------------------- | ------- | ----------------------------- |
| `passwordReset`           | on      | `kit.passwordReset`           |
| `emailVerification`       | on      | `kit.emailVerification`       |
| `emailPasswordManagement` | on      | `kit.emailPasswordManagement` |
| `registration`            | off     | `kit.registration`            |
| `invitations`             | off     | `kit.invitations`             |
| `socialAuthentication`    | off     | `kit.socialAuthentication`    |
| `magicLinkLogin`          | off     | `kit.magicLink`               |
| `sessionManagement`       | off     | `kit.authentication.sessions` |
| `dataExport`              | off     | `kit.accountData`             |
| `accountDeletion`         | off     | `kit.accountData`             |

Login itself is the `authentication` config block (`strategy: 'session' | 'access_tokens'` plus the
existing guard name), used through `kit.authentication`.

Get the service with `await app.container.make(AccountKit)` (import `AccountKit` from
`@kevinjohn/adonisjs-account-kit`).

Integration modes:

| Mode                | Pick it when                                                        | Documentation                                                                                                                                |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Application-owned   | The app has its own controllers, validation, pages or Inertia views | [Application-owned integration](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/guide/application-owned-integration.md) |
| Managed JSON routes | An API or SPA wants ready-made endpoints under a prefix             | [Managed HTTP](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/guide/managed-http.md)                                   |

Both call the same service. Managed routes are registered with `registerManagedRoutes` from
`@kevinjohn/adonisjs-account-kit/http`, and `account-kit:openapi` writes their OpenAPI 3.1 document.

Users adapters:

| Import                                             | For                                     |
| -------------------------------------------------- | --------------------------------------- |
| `@kevinjohn/adonisjs-account-kit/adapters/lucid`   | A Lucid model (the default)             |
| `@kevinjohn/adonisjs-account-kit/adapters/drizzle` | Drizzle                                 |
| `@kevinjohn/adonisjs-account-kit/adapters/prisma`  | Prisma                                  |
| `@kevinjohn/adonisjs-account-kit/adapters/sql`     | Plain SQL through Lucid's query builder |

A custom adapter implements `UsersAdapter` (`@kevinjohn/adonisjs-account-kit/types`) and should pass
`@kevinjohn/adonisjs-account-kit/testing/adapter_contract`. The Lucid adapter requires the `id` primary key and
the column names in the requirements table.

Commands:

| Command                         | Does                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `account-kit:doctor`            | Read-only install check; exit code 1 on failure            |
| `account-kit:setup`             | Previews, then applies, a guided setup from a choices file |
| `account-kit:prune`             | Deletes expired tokens and rows; schedule it               |
| `account-kit:invite`            | Sends an invitation from the shell                         |
| `account-kit:reset-link`        | Prints a password reset link from the shell                |
| `account-kit:openapi`           | Writes the managed routes' OpenAPI document                |
| `account-kit:retirement-impact` | Counts accounts that would lose their only sign-in method  |

Every error extends `AccountKitError` and has a stable `code` and HTTP `status`. See the
[error reference](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/reference/errors.md)
for the full table and fixes. Common errors include `InvalidTokenError` (expired, used or unknown
link), `ThrottledError` (429, `retryAfterSeconds`), `InvalidCredentialsError`,
`InvalidSessionError` (sign the user out) and `CapabilityDisabledError`.

## Invariants: do not break these

1. **Route every account write through Account Kit.** Writing to users, token tables or sessions
   directly skips credential revocation and token cleanup.
2. **Never wrap Account Kit calls in your own transaction.** Each operation owns its transaction
   and passes `trx` to your callbacks; it rejects an active global transaction.
3. **Treat `DeliveryError` and `PostCommitError` as committed.** The change happened; only an email
   or hook failed. On `passwordReset.request` and `passwordReset.reset`, catch both, log, and return
   the normal response. Never retry the operation.
4. **Keep proof URLs secret.** They are bearer tokens: keep them out of logs, analytics and error
   reports, and send `Referrer-Policy` on pages whose URL contains one.
5. **Pass a trusted client key.** `clientKey` is usually `request.ip()`, which needs trusted
   proxies configured. Never accept a client key from the request body or an unverified
   `X-Forwarded-For`.
6. **Session login stores the credential revision.** The guard adapter writes it at sign-in, and
   middleware passes it to `kit.authentication.current` on each request. A missing revision fails
   closed; do not default it.
7. **Do not log or return internal error causes.** Map errors with the
   [error reference](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/reference/errors.md).

## Testing an application

`@kevinjohn/adonisjs-account-kit/testing/notifications` exports `captureNotifications()`. Pass its `notify` as
the config's `notify` in tests, run a flow, then read `tokenFor(kind, email)`.

## Source map

| Path                                                                                                              | Holds                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/account_kit.ts`                                                                                              | The `AccountKit` service and its namespaces                                                                                                                                 |
| `src/config*.ts`                                                                                                  | `defineConfig` and validation of each config block                                                                                                                          |
| `src/capabilities.ts`                                                                                             | Per-capability adapter methods and required hooks                                                                                                                           |
| `src/password_reset.ts`, `src/verification.ts`, `src/credentials.ts`, `src/invitations.ts`, `src/registration.ts` | Account operations                                                                                                                                                          |
| `src/authentication.ts`, `src/session_*.ts`                                                                       | Login, revision checks, signed-in devices                                                                                                                                   |
| `src/magic_link.ts`, `src/social_*.ts`                                                                            | Magic-link and social sign-in                                                                                                                                               |
| `src/account_export.ts`, `src/account_deletion.ts`                                                                | Export and deletion                                                                                                                                                         |
| `src/transaction.ts`, `src/db.ts`, `src/effects.ts`                                                               | Transactions, locking, post-commit effects                                                                                                                                  |
| `src/throttle.ts`                                                                                                 | Rate limiting with HMAC limiter keys                                                                                                                                        |
| `src/admission/`                                                                                                  | Admission (`@kevinjohn/adonisjs-account-kit/admission`); see the [admission guide](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/guide/admission.md) |
| `src/notifications.ts`, `src/log_notifications.ts`                                                                | Built-in emails and development logging                                                                                                                                     |
| `src/http/`                                                                                                       | Managed routes, validators, OpenAPI                                                                                                                                         |
| `src/setup/`                                                                                                      | `account-kit:setup` planning and apply                                                                                                                                      |
| `adapters/`, `stubs/`                                                                                             | Users adapters, generated config and migrations                                                                                                                             |

## Further reading

- [Security model](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/guide/security.md)
- [Getting started](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/guide/getting-started.md)
- [Generated API reference](https://kevinjohn.github.io/oss-adonisjs-account-kit/reference/api/)
- [Glossary](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/reference/glossary.md), for "provision", "pillar" and other package terms

## Tested against

|                         | Every pull request | Weekly and before each release          |
| ----------------------- | ------------------ | --------------------------------------- |
| Node.js                 | 24                 | 24                                      |
| AdonisJS core           | locked version     | lowest supported (7.0.0) and latest 7.x |
| Lucid                   | locked version     | lowest supported and latest 22.x        |
| SQLite (better-sqlite3) | yes                | yes                                     |
| PostgreSQL 16           | yes                | yes                                     |
| MySQL 8.4               | no (experimental)  | experimental                            |
