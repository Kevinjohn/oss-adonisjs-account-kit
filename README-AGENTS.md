# Account Kit: notes for AI coding agents

This file is for an agent deciding whether Account Kit fits an application, and how to integrate it
without breaking its guarantees. People should start with the
[README](https://github.com/Kevinjohn/oss-adonisjs-account-kit#readme). Links point at the
repository so they work from `node_modules` too.

## Fit check

Use it when all of these hold:

- AdonisJS 7 on Node.js 24 or later.
- Users sign in with an email address (password, magic link or Google/GitHub through Ally).
- The application already has, or will have, its own users table and model.
- The database is SQLite, PostgreSQL or MySQL.

Do not use it for two-factor authentication or passkeys (AdonisJS Plus covers those), for
username-only accounts, or as an identity provider for other applications.

## Requirements

| Need              | Detail                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Peer dependencies | `@adonisjs/core` 7, `@adonisjs/lucid` 22.4+, `@adonisjs/limiter` 3, `luxon` 3                                                                       |
| Optional peers    | `@adonisjs/mail` 10 (built-in emails), `@adonisjs/session` 8 (session login), `@vinejs/vine` 4 (managed routes)                                     |
| Environment       | `APP_KEY` of at least 32 bytes, identical on every instance; `APP_URL`, HTTPS in production                                                         |
| Users table       | `email` (unique, stored trimmed and lowercase), `password`, `unverified_email`, `email_verified_at`; `credentials_changed_at` when login is enabled |
| Session login     | A server-side session store (database or Redis). The cookie store is rejected.                                                                      |

## Install

```sh
node ace add @adonisjs/limiter
node ace add adonisjs-account-kit
node ace migration:run
node ace account-kit:doctor
```

`node ace add` writes `config/account_kit.ts`, generates migrations and registers the provider and
commands. `account-kit:doctor` exits 1 and names the fix when the config, limiter, `APP_URL` or
tables are wrong. The generated `notify` callbacks throw until email is configured.

## Capabilities

Set in `enabled` in `config/account_kit.ts`. Each one needs the adapter methods and hooks listed in
`src/capabilities.ts`; configuration fails at boot when one is missing.

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
`adonisjs-account-kit`).

## Integration modes

| Mode                | Pick it when                                                        | Docs                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Application-owned   | The app has its own controllers, validation, pages or Inertia views | [application-owned-integration](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/application-owned-integration.md) |
| Managed JSON routes | An API or SPA wants ready-made endpoints under a prefix             | [managed-http](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/managed-http.md)                                   |

Both call the same service. Managed routes are registered with `registerManagedRoutes` from
`adonisjs-account-kit/http`, and `account-kit:openapi` writes their OpenAPI 3.1 document.

## Users adapters

| Import                                  | For                                     |
| --------------------------------------- | --------------------------------------- |
| `adonisjs-account-kit/adapters/lucid`   | A Lucid model (the default)             |
| `adonisjs-account-kit/adapters/drizzle` | Drizzle                                 |
| `adonisjs-account-kit/adapters/prisma`  | Prisma                                  |
| `adonisjs-account-kit/adapters/sql`     | Plain SQL through Lucid's query builder |

A custom adapter implements `UsersAdapter` (`adonisjs-account-kit/types`) and should pass
`adonisjs-account-kit/testing/adapter_contract`. The Lucid adapter requires the `id` primary key and
the column names in the requirements table.

## Commands

| Command                         | Does                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `account-kit:doctor`            | Read-only install check; exit code 1 on failure            |
| `account-kit:setup`             | Previews, then applies, a guided setup from a choices file |
| `account-kit:prune`             | Deletes expired tokens and rows; schedule it               |
| `account-kit:invite`            | Sends an invitation from the shell                         |
| `account-kit:reset-link`        | Prints a password reset link from the shell                |
| `account-kit:openapi`           | Writes the managed routes' OpenAPI document                |
| `account-kit:retirement-impact` | Counts accounts that would lose their only sign-in method  |

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
7. **Do not log or return internal error causes.** Map errors with `docs/reference/errors.md`.

## Errors

Every error extends `AccountKitError` and has a stable `code` and HTTP `status`. The full table,
with fixes, is [docs/reference/errors.md](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/reference/errors.md). Common ones: `InvalidTokenError` (expired, used or
unknown link), `ThrottledError` (429, `retryAfterSeconds`), `InvalidCredentialsError`,
`InvalidSessionError` (sign the user out), `CapabilityDisabledError`.

## Testing an application

`adonisjs-account-kit/testing/notifications` exports `captureNotifications()`. Pass its `notify` as
the config's `notify` in tests, run a flow, then read `tokenFor(kind, email)`.

## Source map

| Path                                                                                                              | Holds                                              |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/account_kit.ts`                                                                                              | The `AccountKit` service and its namespaces        |
| `src/config*.ts`                                                                                                  | `defineConfig` and validation of each config block |
| `src/capabilities.ts`                                                                                             | Per-capability adapter methods and required hooks  |
| `src/password_reset.ts`, `src/verification.ts`, `src/credentials.ts`, `src/invitations.ts`, `src/registration.ts` | Account operations                                 |
| `src/authentication.ts`, `src/session_*.ts`                                                                       | Login, revision checks, signed-in devices          |
| `src/magic_link.ts`, `src/social_*.ts`                                                                            | Magic-link and social sign-in                      |
| `src/account_export.ts`, `src/account_deletion.ts`                                                                | Export and deletion                                |
| `src/transaction.ts`, `src/db.ts`, `src/effects.ts`                                                               | Transactions, locking, post-commit effects         |
| `src/throttle.ts`                                                                                                 | Rate limiting with HMAC limiter keys               |
| `src/notifications.ts`, `src/log_notifications.ts`                                                                | Built-in emails and development logging            |
| `src/http/`                                                                                                       | Managed routes, validators, OpenAPI                |
| `src/setup/`                                                                                                      | `account-kit:setup` planning and apply             |
| `adapters/`, `stubs/`                                                                                             | Users adapters, generated config and migrations    |

## Further reading

- [Security model](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/security.md)
- [Getting started](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/getting-started.md)
- [Glossary](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/glossary.md), for "provision", "pillar" and other package terms
