# Account Kit for AdonisJS

[![checks](https://github.com/Kevinjohn/oss-adonisjs-account-kit/actions/workflows/checks.yml/badge.svg?branch=main)](https://github.com/Kevinjohn/oss-adonisjs-account-kit/actions/workflows/checks.yml)
[![npm](https://img.shields.io/npm/v/adonisjs-account-kit)](https://www.npmjs.com/package/adonisjs-account-kit)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE.md)
[![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933)](package.json)
[![AdonisJS 7](https://img.shields.io/badge/AdonisJS-7-5a45ff)](https://adonisjs.com)
[![Coverage 92%](https://img.shields.io/badge/coverage-92%25-brightgreen)](CONTRIBUTING.md#checks)

Password reset, email verification, invitations and account settings for AdonisJS 7, with the
security details handled. You keep your user model, your routes and your policies.

![A password reset in a new AdonisJS app: the doctor passes, a reset request returns the generic response, the dev server log prints the email, the link resets the password once and is rejected the second time](docs/assets/demo.svg)

## What you get

The account flows every AdonisJS app ends up writing by hand:

- **Forgot password** with single-use, expiring links and the same response for known and unknown
  addresses.
- **Signup and email verification**, open, closed, or behind your own admission rule.
- **Login** with sessions or access tokens through your existing Auth guard. Changing a password or
  email signs out older sessions and tokens.
- **Account settings**: change password, change email with confirmation, update profile.
- **Invitations** with roles, resend and revoke.

Each flow comes with its emails, rate limits and test helpers. Call it from your own controllers, or mount
the managed JSON routes.

## Additional features

Use the ones you need; the rest stay out of the way:

- **Magic-link sign-in**: a one-use email link that only works in the browser or app that asked
  for it.
- **Signed-in devices**: list sign-ins, sign out one device, every other device, or everywhere.
- **Account export and deletion**: a JSON download of the user's data and permanent deletion, for
  GDPR requests.
- **Google and GitHub sign-in** through Ally.
- **Operator commands**: `account-kit:invite` and `account-kit:reset-link` from the shell.
- **OpenAPI 3.1 document** for the managed routes.
- **Drizzle, Prisma and plain SQL** users adapters, as well as Lucid.

[All features](docs/features.md) has the details of each.

## Install

```sh
node ace add @adonisjs/limiter
node ace add adonisjs-account-kit
node ace migration:run
node ace account-kit:doctor
```

`node ace add` writes `config/account_kit.ts`, generates the migrations and registers the provider
and commands. The doctor checks the config, limiter, `APP_URL` and database:

![account-kit:doctor output with every check passing](docs/assets/doctor.svg)

The generated `notify` callbacks throw until you choose how to send email, and the doctor cannot
run them; the [getting started tutorial](docs/getting-started.md#3-print-emails-to-the-terminal)
sets them up.

Requirements: Node.js 24+, AdonisJS 7 with Lucid on SQLite, PostgreSQL or MySQL, `@adonisjs/limiter`, a stable `APP_KEY` of at
least 32 characters and an `APP_URL`.

## A forgot-password flow in two routes

```ts
// app/controllers/password_resets_controller.ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, DeliveryError, PostCommitError } from 'adonisjs-account-kit'

export default class PasswordResetsController {
  async request({ request, response, logger }: HttpContext) {
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.request({ email: request.input('email'), clientKey: request.ip() })
    } catch (error) {
      // Only known addresses get an email, so a failed send must not change the response.
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      logger.error({ err: error }, 'password reset email failed')
    }
    return response.accepted({ message: 'If the account exists, instructions will be sent.' })
  }

  async complete({ request, params, logger }: HttpContext) {
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.reset({ token: params.token, password: request.input('password') })
    } catch (error) {
      // The password has already changed; only the follow-up email failed.
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      logger.error({ err: error }, 'password reset notice failed')
    }
    return { message: 'Password reset.' }
  }
}
```

The [getting started tutorial](docs/getting-started.md) takes you from a new API starter app to a
working reset, with the email printed to your terminal, in about ten minutes.

## How it fits together

```mermaid
flowchart LR
  client[Your frontend or API client] --> routes
  subgraph app[Your AdonisJS app]
    routes[Your controllers<br/>or managed routes] --> kit[AccountKit service]
    kit --> adapter[Users adapter<br/>Lucid model]
    kit --> notify[notify callbacks<br/>AdonisJS Mail]
    kit --> guard[Your Auth guard<br/>session or tokens]
    kit --> limiter["@adonisjs/limiter"]
  end
  adapter --> db[(Your database<br/>users + package tables)]
```

Account Kit owns the account transaction: tokens, locking, revocation and events. Your app owns the
HTTP layer, validation, authorization and the user model.

## Security

- Tokens are 40 random bytes by default. Only their SHA-256 hash is stored, and each works once.
- Reset requests return the same response and take at least 300 ms whether or not the address
  exists. Failed logins return one generic error.
- Links are built only from configured origins, never from the request `Host` header.
- Rate-limit keys are HMAC digests, so the limiter store never holds an email address or IP.
- Every account change runs in one transaction with the user row locked.

The [security model](docs/security.md) lists every defence and its default, what your app must still
do, and what is out of scope. Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Before production

- Configure trusted proxies before passing `request.ip()` as `clientKey`.
- Store email addresses trimmed and lowercase, with a single-column unique index.
- Keep `APP_KEY` identical on every instance that shares a limiter store.
- Do not wrap Account Kit calls in your own transaction; each operation owns its transaction and
  passes `trx` to your callbacks.
- On SQLite, enable foreign keys on every connection.
- Schedule `node ace account-kit:prune` to delete expired tokens.
- Keep proof links out of access logs and analytics.

Details: [operations](docs/operations.md), [custom user model](docs/recipes/custom-user-model.md)
and [usage](docs/usage.md#transactions-and-callbacks).

## When to use it

- **Use Account Kit** when you want the standard account flows in an AdonisJS app that already has
  its own user model, and you want to keep your own routes and frontend.
- **Use [AdonisJS Plus](https://plus.adonisjs.com)** for two-factor authentication and passkeys.
  Account Kit uses the same vocabulary as Plus and the AdonisJS starter kits.
- **Write it yourself** when your flows differ from email-and-password accounts. The
  [security model](docs/security.md) is a useful checklist either way.

## Testing your app

```ts
import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'

const mail = captureNotifications() // pass mail.notify as Account Kit's notify config in tests
// ...request a reset, then:
const token = mail.tokenFor('passwordResetProvision', 'someone@example.com')
```

See [testing your account flows](docs/recipes/testing.md).

## Bring your own ORM

Users live behind a small `UsersAdapter` interface. Lucid, Drizzle, Prisma and plain SQL adapters
ship with the package; see [users adapters](docs/adapters.md). For anything else, `adonisjs-account-kit/testing/adapter_contract` runs the same behaviour checks the
Lucid adapter passes, so you can prove your adapter is correct. See
[custom adapter](docs/recipes/custom-adapter.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Inertia React example app](examples/inertia-react/README.md): the starter kit with signup,
  email confirmation, forgot password and change password
- [Recipes](docs/README.md#how-to-guides): tokens, sessions, Inertia, social sign-in, email
  templates, multi-tenant and more
- [Reference](docs/README.md#reference): configuration, errors, endpoints, glossary
- [Security model](docs/security.md)
- [Changelog](CHANGELOG.md)

## Verifying a release

Releases are published from GitHub Actions with npm provenance. Run `npm audit signatures` in your
app to check that the installed package was built from this repository.

## Contributing

Bug reports, docs fixes, recipes and adapters are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
to get the test suite running, or start with no local setup:

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Kevinjohn/oss-adonisjs-account-kit)

## License

[MIT](LICENSE.md)
