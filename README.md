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
`email_verified_at`. Keep `email` unique; on PostgreSQL, name that constraint
`users_email_unique`. Normalize it to trimmed lowercase before storing it. The generated
adapter looks up that normalized value with exact indexed equality. Hash a
changed password in a `beforeSave` hook; the generated API kit's `withAuthFinder(hash)` hook does
this. The adapter assigns plaintext passwords through the model, so avoid hashing them again in the
adapter. Set `APP_URL` to the application's base URL in `.env` and declare it in `start/env.ts`, for
example `APP_URL: Env.schema.string({ format: 'url', tld: false })`. When using SQLite, enable
`foreign_keys` for every database connection so the migration's `CASCADE` and `SET NULL` rules are
enforced. In the generated API kit's `config/database.ts`, add this to the SQLite connection:

```ts
pool: {
  min: 1,
  max: 4,
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

### Package transactions

Account Kit write methods manage their own root transactions. Do not call them inside an
already-active global transaction on either SQLite or PostgreSQL; the package rejects that usage.
In tests, use isolated or resettable database fixtures instead of wrapping package writes in a
global transaction such as `wrapInGlobalTransaction`.

SQLite can retry a contended transaction, so transaction callbacks may run again. Keep adapter
writes and `onInvitationAccepted` database work inside the supplied `trx`, and leave notifications
and other external effects until after the transaction commits. PostgreSQL does not retry
transactions; transient database errors can propagate to the caller.
Invitation management authorization runs inside the package transaction and may be called again
on a SQLite retry. Keep those callbacks read-only and retry-safe. Their signatures do not include
the transaction; prefer permission state already loaded for the actor. If they make ordinary
database reads through another connection, configure enough pool capacity and concurrency for
that connection. A SQLite pool limited to one connection cannot serve those reads while the
package transaction holds it.

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
until replaced. Enqueue the message promptly from this callback; it runs after the token transaction
commits, and a callback failure becomes `DeliveryError`. The configured minimum request duration is
a floor, not a constant-time or non-enumeration guarantee: slow lookups, contention, queueing, or
synchronous delivery can make known-account requests take longer. Do not return the callback cause
to the requester. The callback can use your application's queue or mail service; the package does
not add a Mail dependency.

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

## Email verification

The generated `urls.verification` callback builds `/account-kit/verification/<token>` from
`APP_URL`. Serve that path as a token-completion page or endpoint; if your routes use a prefix,
update the callback to match. Set `Referrer-Policy: no-referrer` on the token page so the link is
not sent as a referrer.

The generated config sets `ttl.verification` to `1h` and the shared `throttle` to
`{ requests: 5, duration: '15m' }`. Verification sends are keyed by user ID. The generated
`notify.verification(user, url)`
placeholder throws until configured. Queue or send the message from that callback. A callback
failure becomes `DeliveryError` with the original error in `cause`; log it privately and return a
generic response rather than exposing the cause.

With a resolved `AccountKit` instance named `kit`, send a verification link only from an
authenticated action, using that user's ID:

```ts
const result = await kit.verification.send({ userId })
// 'sent' or 'already_verified'
```

An unknown user ID throws `InvalidInputError`. Already-verified users return
`'already_verified'` without another notification. The callback receives the user's `AccountUser`
value and the configured verification URL.

The link is encrypted for the `account-kit:verify-email` purpose and expires at the configured TTL.
Completion checks that the token's user ID and email still match the current account, so a link
issued before an email change cannot verify the new address. A malformed, expired, wrong-purpose,
or stale-address token throws `InvalidTokenError`.

Call completion from the public token endpoint with the token from the URL and the resolved `kit`:

```ts
const result = await kit.verification.complete({ token })
// 'verified' on the first visit; 'already_verified' on a repeat visit
```

Completion is repeatable: revisiting a valid link returns `'already_verified'` after the first
successful verification. Do not treat this result as a sign-in or promise that existing sessions
have ended.

## Invitations

Invitations let an authorized actor invite an unregistered email with an application-defined role.
The `role` is an opaque string to the package; assign it to the new user in the required
`onInvitationAccepted(user, invitation, trx)` callback, using the supplied transaction. If the
callback fails, invitation consumption, user creation, and the role write roll back together.
SQLite may retry a contended transaction, so keep this callback to database work through `trx` and
leave mail or other external effects to post-commit notification callbacks.

The generated invitation URL uses `/account-kit/invitation/<token>` from `APP_URL`; serve it with a
GET inspection page and a POST acceptance action. Set `Referrer-Policy: no-referrer` on token pages.
The default invitation TTL is seven days (`ttl.invitation: '7d'`).

The generated config requires `authorize.invite(actor, role)`,
`authorize.manageInvitation(actor, invitation)`, `authorize.listInvitations(actor)`,
`urls.invitation(token)`, and `notify.invitation(invitation, url)`. Each authorization callback
must return exactly `true` to allow its action. Configure the URL callback to match your route and
the notification callback to queue or send the invitation; the generated callback throws until
you configure it. Resend calls `manageInvitation` and the current role's `invite` callback within
its transaction; revoke calls `manageInvitation` there. Apply the transaction and pool guidance
above to any database-backed policy checks.

Send and resend notifications happen after their database commits; a failure becomes
`DeliveryError` with the cause. The invitation row is already committed. A failed resend has
already rotated the token, so the previous link is no longer valid.

Use authenticated actions for sending, listing, resending, and revoking, passing the authenticated
actor's ID. The methods are:

```ts
await kit.invitations.send({ actorId, email, role })
await kit.invitations.list({ actorId })
await kit.invitations.inspect({ token })
await kit.invitations.accept({ token, password })
await kit.invitations.resend({ actorId, invitationId })
await kit.invitations.revoke({ actorId, invitationId })
```

`inspect` is public and non-consuming; return its invitation email and role to render the
confirmation page. `accept` consumes the token on POST and returns an `AccountUser`; the accepted
email is verified. The application owns password policy and confirmation validation.

Sending to an email that already belongs to a registered user throws
`EmailAlreadyRegisteredError`; the actor can be told to invite a different address. A pending
invitation for the same email throws `InvitationPendingError`. Acceptance also rejects an email
that became registered after the invitation was sent, and rolls the invitation consumption back.
The inviter's permissions are not rechecked when the recipient accepts. The invitation remains
bounded by its expiry, an authorized revoke, or a resend. Resending checks both `manageInvitation` and the current
`invite(actor, invitation.role)` grant, so permission for the role must still exist. Listing also
requires `listInvitations` and returns only unexpired invitations.

## Credential changes

Use the authenticated user's ID as `actorId` for both authenticated methods. The package checks the
current password before changing a password or requesting an email change. Both operations share the
per-user identity throttle, which defaults to five attempts per 15 minutes. The application remains
responsible for its password policy and confirmation fields.

```ts
await kit.credentials.changePassword({ actorId, currentPassword, newPassword })
await kit.credentials.requestEmailChange({ actorId, currentPassword, newEmail })
await kit.credentials.completeEmailChange({ token })
```

Both authenticated methods require an existing password and throw `NoPasswordError` for a
social-only account. That user can set their first password through the recovery flow. A wrong or
missing current password throws `IdentityNotConfirmedError`. After a successful password change,
pending recovery and email-change links are invalidated. Recovery resets also invalidate pending
email-change links.

`requestEmailChange` normalizes the new address, requires current-password proof, and replaces any
earlier pending email-change request for that user. A registered address throws
`EmailAlreadyRegisteredError`. The default `ttl.emailChange` is one hour. The generated
`notify.emailChangeConfirm(user, newEmail, url)` callback throws until configured; it runs after the
request commits. After password proof and throttling, requesting the user's current normalized
email is a no-op. A notification failure becomes `DeliveryError`, while the request remains stored.

The generated email-change URL is `/account-kit/email-change/<token>` from `APP_URL`. Use GET only
to display a landing page with a confirmation action; there is no email-change inspection method.
Set `Referrer-Policy: no-referrer` on the token page, then call `completeEmailChange` only from its
POST action. Completion verifies the account still has the email address bound to the request,
changes and verifies the new address, invalidates pending recovery links, and returns an
`AccountUser`. Completion is single-use; malformed, expired, replayed, or stale links throw
`InvalidTokenError`. A new request replaces an earlier link, and a stale current-email binding
cannot be used.

After a recovery reset, password change, or completed email change commits, the optional
`onCredentialsChanged(user)` callback can revoke application credentials. For an API kit with
access tokens, one option is to delete all tokens for that user:

```ts
onCredentialsChanged: async (accountUser) => {
  const User = (await import('#models/user')).default
  const user = await User.find(accountUser.id)
  if (user) await User.accessTokens.deleteAll(user)
},
```

This callback receives an `AccountUser` value, not a Lucid model, so load the model when the callback
runs. It runs after the database commit. When email change completes, `notify.emailChanged(previousEmail,
user)` runs after `onCredentialsChanged`; both are post-commit. A thrown callback or notification
error becomes `PostCommitError` with its original `cause`, and the committed credential change
remains in place. Do not expose causes from either `DeliveryError` or `PostCommitError`; log them
privately and return a generic public response. These operations do not terminate existing web
sessions in v1.

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

The three generated migrations reference `users.id`; if that key uses a string or UUID type, change
the user foreign-key column in each recovery-token, invitation, and email-change migration to the
matching database type. The test users adapter stores normalized email addresses in a unique
`email` column (named `users_email_unique` on PostgreSQL) and hashes
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
