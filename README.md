# adonisjs-account-kit

Account recovery, email verification, invitations and credential changes for AdonisJS 7.

Development requires Node 24 or newer and pnpm.

## Install

Until the package is published, install a local tarball. Run the first two commands in this repository,
then create the app and run the remaining commands from `/tmp`:

```sh
pnpm build
pnpm pack --pack-destination /tmp
cd /tmp
pnpm create adonisjs@latest scratch --kit=api --pkg=pnpm
cd scratch
pnpm exec node ace add @adonisjs/limiter
pnpm add /tmp/adonisjs-account-kit-0.0.0.tgz
pnpm exec node ace configure adonisjs-account-kit
```

Before running the migrations and typecheck, complete the application prerequisites below. The
generated migration adds the nullable `email_verified_at` column; with Lucid schema generation
enabled, running migrations also regenerates the `UserSchema` declaration. The generated API kit's
SQLite setup works without a database service. For PostgreSQL, install the driver with
`pnpm add pg`, configure a `pg` connection in `config/database.ts`, and provide its connection
settings in your environment before running migrations.

## Application prerequisites

The generated `config/account_kit.ts` expects the application model at `#models/user` to expose
`email`, `password`, and nullable `emailVerifiedAt` fields mapped to `email`, `password`, and
`email_verified_at`. Keep `email` unique and normalize it to trimmed lowercase when saving. Hash a
changed password in a `beforeSave` hook; the generated API kit's `withAuthFinder(hash)` hook does
this. The adapter assigns plaintext passwords through the model, so avoid hashing them again in the
adapter. Set `APP_URL` to the application's base URL in `.env` and declare it in `start/env.ts`, for
example `APP_URL: Env.schema.string({ format: 'url', tld: false })`. When using SQLite, enable
`foreign_keys` for every database connection so the migration's `CASCADE` and `SET NULL` rules are
enforced. In the generated API kit's `config/database.ts`, add this to the SQLite connection:

```ts
pool: {
  afterCreate(connection, callback) {
    connection.pragma('foreign_keys = ON')
    callback(null, connection)
  },
},
```

After setting `APP_URL`, completing the User model prerequisites, and enabling SQLite foreign keys
when applicable, run the migrations and typecheck:

```sh
pnpm exec node ace migration:run
pnpm typecheck
```

## Password recovery

The generated `urls.recovery` callback builds `/account-kit/recovery/<token>` from `APP_URL`; serve
that path with a GET page-inspection action and a POST password-reset action. Add a separate POST
endpoint for recovery requests. If your routes use a prefix, update `urls.recovery` to match it.

The relevant `defineConfig` settings default to a one-hour recovery token, five requests per
15 minutes for each client key and normalized email, and a 300 ms minimum duration for recovery
requests:

```ts
ttl: { recovery: '1h' },
throttle: { requests: 5, duration: '15m' },
minRequestMs: 300,
```

Configure `notify.recovery(user, url)` in `config/account_kit.ts`; the generated placeholder throws
until replaced. Queue or send the message from this callback. It runs after the token transaction
commits, and a callback failure becomes `DeliveryError`. Do not return its cause to the requester.
The callback can use your application's queue or mail service; the package does not add a Mail
dependency.

Put request and reset validators in `app/validators/recovery.ts`. Choose password length and
confirmation rules to match your application's policy:

```ts
import vine from '@vinejs/vine'

export const recoveryRequestValidator = vine.compile(
  vine.object({ email: vine.string().trim().email().maxLength(254) })
)

export const recoveryResetValidator = vine.compile(
  vine.object({
    password: vine.string().minLength(12).maxLength(128).confirmed({ as: 'password_confirmation' }),
    password_confirmation: vine.string().minLength(12).maxLength(128),
  })
)
```

In `app/controllers/forgot_password_controller.ts`, use one public acknowledgement for a known or
unknown email, including when delivery fails. Throttling can return a generic 429 with `Retry-After`:

```ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, DeliveryError, ThrottledError } from 'adonisjs-account-kit'
import { recoveryRequestValidator } from '#validators/recovery'

const acknowledgement = { message: 'If the account exists, recovery instructions will be sent.' }

export default class ForgotPasswordController {
  async store({ request, response }: HttpContext) {
    const { email } = await request.validateUsing(recoveryRequestValidator)
    const kit = await app.container.make(AccountKit)

    try {
      await kit.recovery.request({ email, clientKey: request.ip() })
    } catch (error) {
      if (error instanceof ThrottledError) {
        response.header('Retry-After', String(error.retryAfterSeconds))
        return response.tooManyRequests({ message: 'Please wait before trying again.' })
      }
      if (!(error instanceof DeliveryError)) throw error
    }

    return response.accepted(acknowledgement)
  }
}
```

In `app/controllers/reset_password_controller.ts`, inspect without consuming on GET, then consume
the token on POST. Set `Referrer-Policy: no-referrer` on both token responses so the bearer token is
not sent as a referrer. Replace the valid GET response with your page or SPA handoff:

```ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, InvalidTokenError } from 'adonisjs-account-kit'
import { recoveryResetValidator } from '#validators/recovery'

const invalidLink = { message: 'This recovery link is invalid or expired.' }

export default class ResetPasswordController {
  async show({ params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const kit = await app.container.make(AccountKit)
    if (!(await kit.recovery.inspect({ token: params.token }))) {
      return response.unprocessableEntity(invalidLink)
    }
    return response.ok({ valid: true })
  }

  async store({ params, request, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const { password } = await request.validateUsing(recoveryResetValidator)
    const kit = await app.container.make(AccountKit)

    try {
      await kit.recovery.reset({ token: params.token, password })
    } catch (error) {
      if (error instanceof InvalidTokenError) return response.unprocessableEntity(invalidLink)
      throw error
    }

    return response.accepted({ message: 'Password reset. You can now sign in.' })
  }
}
```

Recovery reset returns an `AccountUser` value, not a Lucid model or session. Let the user sign in
through your normal flow after reset; do not treat the returned value as an authenticated session.

Tests use SQLite by default and need no database service. SQLite is stored in a temporary file
with WAL enabled so tests can use separate connections. To run the suite against PostgreSQL,
start a local PostgreSQL 16 database and set `DB_CLIENT=pg` plus the connection variables below.
The defaults match the repository's local PostgreSQL test service.

| Variable      | Default            | Purpose                         |
| ------------- | ------------------ | ------------------------------- |
| `DB_CLIENT`   | `better-sqlite3`   | Select `better-sqlite3` or `pg` |
| `DB_HOST`     | `127.0.0.1`        | PostgreSQL host                 |
| `DB_PORT`     | `55432`            | PostgreSQL port                 |
| `DB_USER`     | `account_kit`      | PostgreSQL user                 |
| `DB_PASSWORD` | empty              | PostgreSQL password             |
| `DB_DATABASE` | `account_kit_test` | PostgreSQL database             |

For example, `DB_CLIENT=pg pnpm test` runs the same tests against PostgreSQL.

The test users adapter stores normalized email addresses in a unique `email` column and hashes
passwords through the booted application's hash service. Its transaction-aware methods use the
supplied Lucid transaction. SQLite tests use WAL with a four-connection pool and a per-connection
busy timeout of 5 seconds.

Database-only work can use the internal `transaction(db, callback)` helper. The callback may be
re-run after a SQLite busy error, so it must contain only transaction-bound database work;
notifications and other side effects belong after the helper resolves. On SQLite, the helper
temporarily disables the connection's blocking busy timeout, rolls back a busy attempt, waits
asynchronously and retries the whole callback for up to 5 seconds. PostgreSQL uses Lucid's
managed transaction directly.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Implementation follows `PLAN.md`. The working package name will be settled before publication.
