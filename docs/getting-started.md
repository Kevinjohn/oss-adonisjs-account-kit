# Getting started

This focused tutorial adds password reset to an AdonisJS 7 API starter using its existing opaque
`api` guard and `auth_access_tokens` table. For signup through protected access, settings, and
reset in one namespace, start with the [complete core API walkthrough](guides/core-api.md).

## Before you start

You need:

- Node.js 24 or newer.
- An AdonisJS 7 application with Lucid and a `users` table. The API starter kit has both:

  ```sh
  pnpm create adonisjs@latest my-app --kit=api
  ```

- A stable `APP_KEY` of at least 32 characters and `APP_URL=http://localhost:3333` in `.env`.
  Production action links require a public HTTPS origin. Configure trusted proxies before using
  `request.ip()` as the rate-limit client identity.

## 1. Install

Account Kit uses `@adonisjs/limiter` for rate limits. Add it first, then add Account Kit. When
the limiter asks for a storage layer, choose `database`; it adds a `rate_limits` migration that
step 2 runs:

```sh
node ace add @adonisjs/limiter
node ace add adonisjs-account-kit
```

The second command installs the package, writes `config/account_kit.ts`, generates the package
migrations, and registers the provider and Ace commands in `adonisrc.ts`.

## 2. Run the migrations

```sh
node ace migration:run
```

The migrations add `unverified_email`, `email_verified_at` and `credentials_changed_at` to
`users` and create the token tables. AdonisJS regenerates `database/schema.ts`, so the `User` model
picks up the new columns.

Account Kit stores email addresses trimmed and lowercase. If your model does not normalize them
yet, add a hook:

```ts
// app/models/user.ts
import { beforeSave } from '@adonisjs/lucid/orm'

// inside the User class:
@beforeSave()
static normalizeEmail(user: User) {
  user.email = user.email.trim().toLowerCase()
}
```

Keep the starter's hashed password column, `withAuthFinder` password verification, `api` guard,
`User.accessTokens` provider and `auth_access_tokens` migration. Normalize existing email rows
and resolve duplicates before enabling recovery.

## 3. Print emails to the terminal

The generated config throws on every notification until you choose how to send mail. For now,
print messages to the log. In `config/account_kit.ts`, import two helpers:

```ts
import app from '@adonisjs/core/services/app'
import { createLogNotifications } from 'adonisjs-account-kit'
```

Replace the whole `notify: { ... }` block, and delete the `notConfigured` helper above
`defineConfig`, which is now unused:

```ts
notify: createLogNotifications({
  brandName: 'My App',
  environment: app.inProduction ? 'production' : 'development',
}),
```

Configure the starter's existing opaque guard in the generated `defineConfig` object:

```ts
passwordPolicy: { minLength: 8, maxLength: 256 },
authentication: {
  strategy: 'access_tokens',
  guard: 'api',
  tokenTable: 'auth_access_tokens',
  tokenExpiresIn: '1d',
  tokenAbilities: ['*'],
  // Applies to Account Kit sign-in calls; the starter's own login uses its own checks.
  canAccess: async () => true,
},
onCredentialsChangedTransaction: async () => {},
```

This explicit `canAccess` policy permits every account through Account Kit authentication calls.
The unchanged starter login and protected routes use their own checks; enforce any suspension
policy there separately. `tokenExpiresIn` and `tokenAbilities` configure tokens issued by Account
Kit, while the starter login retains its own issuance settings. Broad `['*']` ability does not
replace route authorization. With this integration,
Account Kit deletes all of the user's rows in `auth_access_tokens` in the password-reset
transaction. The empty callback is justified only when there are no other application-owned
credentials. If you issue separate sessions, remember-me tokens or API keys, revoke them using
the callback's transaction. See [access tokens](recipes/access-tokens.md).

The generated config also enables `registration` with `availability: 'open'`. Nobody can sign up
through Account Kit until you add a signup route; before you do, set `availability` to `closed`,
or to `application` for your own signup rule. See [registration](registration.md).

## 4. Check the installation

```sh
node ace account-kit:doctor
```

Every installation check should be green. A red line names the step that fixes it. The doctor
checks required tables and columns, including password nullability when social registration may
create passwordless users. Its final **Unverified** summary is informational: it does not run
notification callbacks, application policy, or credential revocation. The reset and protected-route
checks below supply that smoke test.

![account-kit:doctor checking the configuration, limiter, APP_URL and tables in a new app](assets/demos/doctor.svg)

## 5. Validate input and add the routes

This application's chosen password policy is 8–256 characters, matching its config above.
Create `app/validators/password_reset.ts`:

```ts
import vine from '@vinejs/vine'

export const recoveryRequestValidator = vine.create({
  email: vine.string().trim().toLowerCase().email().maxLength(254),
})
export const recoveryProofValidator = vine.create({ token: vine.string().minLength(1) })
export const recoveryCompleteValidator = vine.create({
  password: vine.string().minLength(8).maxLength(256),
})
```

Vine field failures follow AdonisJS's normal validation response. The service still checks its
password and proof rules.

Create a controller:

```ts
// app/controllers/password_resets_controller.ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import {
  AccountKit,
  DeliveryError,
  PostCommitError,
  accountErrorResponse,
} from 'adonisjs-account-kit'
import {
  recoveryCompleteValidator,
  recoveryProofValidator,
  recoveryRequestValidator,
} from '#validators/password_reset'

const acknowledgement = { message: 'If the account exists, instructions will be sent.' }

function knownError(ctx: HttpContext, error: unknown) {
  const mapped = accountErrorResponse(error)
  if (!mapped) throw error
  for (const [name, value] of Object.entries(mapped.headers)) ctx.response.header(name, value)
  return ctx.response.status(mapped.status).send(mapped.body)
}

export default class PasswordResetsController {
  async request(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(recoveryRequestValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.request({ email, clientKey: ctx.request.ip() })
    } catch (error) {
      // Delivery happens after commit. Keep one response for known and unknown accounts.
      if (!(error instanceof DeliveryError || error instanceof PostCommitError))
        return knownError(ctx, error)
      ctx.logger.error({ code: error.code }, 'password reset email failed')
    }
    return ctx.response.accepted(acknowledgement)
  }

  async complete(ctx: HttpContext) {
    const { token } = await ctx.request.validateUsing(recoveryProofValidator, {
      data: { token: ctx.params.token },
    })
    const { password } = await ctx.request.validateUsing(recoveryCompleteValidator)
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.reset({ token, password })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError))
        return knownError(ctx, error)
      // The password and token revocation already committed.
      ctx.logger.error({ code: error.code }, 'password reset notice failed')
    }
    return ctx.response.ok({ message: 'Password reset.' })
  }
}
```

Register the routes:

```ts
// start/routes.ts
const PasswordResetsController = () => import('#controllers/password_resets_controller')

router.post('account-kit/request-recovery', [PasswordResetsController, 'request'])
router.post('account-kit/recovery/:token', [PasswordResetsController, 'complete'])
```

The paths match the `urls.passwordReset` builder in the generated config, which produces links
of the form `APP_URL/account-kit/recovery/<token>`. In a real application that link points at
your frontend page, which then posts the new password to the API. The request endpoint has a
distinct path, so a completion POST without a token segment has no matching route and returns
AdonisJS's ordinary 404. Redact proof-bearing URL paths
and query strings from access logs and error reports. Unknown operational errors are rethrown to
the application's ordinary reporting; known package errors use the
[supported mapping](reference/errors.md).

## 6. Try it

Start the server and create a fictional account through the starter's signup route. Log in twice
through its `/api/v1/auth/login` route and keep both returned bearer tokens private. Before reset,
call `/api/v1/account/profile`, which the starter protects with its `api` guard, with each token
and confirm both succeed. Then request a reset:

```sh
node ace serve --hmr
curl -X POST http://localhost:3333/api/v1/auth/signup -H 'content-type: application/json' \
  -d '{"fullName":"Example Person","email":"person@example.test","password":"old-password-123","passwordConfirmation":"old-password-123"}'
curl -X POST http://localhost:3333/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"person@example.test","password":"old-password-123"}'
curl -X POST http://localhost:3333/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"person@example.test","password":"old-password-123"}'
curl -H 'Authorization: Bearer <first-token>' http://localhost:3333/api/v1/account/profile
curl -H 'Authorization: Bearer <second-token>' http://localhost:3333/api/v1/account/profile
curl -X POST http://localhost:3333/account-kit/request-recovery -H 'content-type: application/json' \
  -d '{"email":"person@example.test"}'
```

The terminal running the server prints the email, including a line like
`Reset password: http://localhost:3333/account-kit/recovery/<proof>`. Inspect this only in the
private development terminal; do not put proofs into production logs or shared test output.
Complete the reset with that proof:

```sh
curl -X POST 'http://localhost:3333/account-kit/recovery/<proof>' \
  -H 'content-type: application/json' -d '{"password":"new-password-123"}'
```

The response is `200 {"message":"Password reset."}`. Both old bearer tokens must now fail on
the **same protected application route**; the new password must log in and the old password must
fail. Posting the same proof again returns a mapped `422 E_ACCOUNT_KIT_INVALID_TOKEN` response.
Missing or malformed email and missing or policy-rejected password receive normal AdonisJS
validation errors. A completion POST without a proof segment receives the route's 404; a
nonempty invalid proof receives
the mapped package error. Valid requests for known and unknown addresses return the identical
`202` acknowledgement, including when a committed request's notification fails. If the completion
notice fails after commit, the controller still reports the successful password change.

## Next steps

- Extend the application's HTTP handling: [application-owned integration](application-owned-integration.md)
  and [error reference](reference/errors.md).
- Send real email: [notifications](notifications.md) and
  [custom email templates](recipes/email-templates.md).
- Add signup, verification, login and protected settings with the
  [complete core API walkthrough](guides/core-api.md); use the [recipes](README.md#how-to-guides)
  for individual flows and invitations.
- Prefer not to write controllers? Mount the [managed JSON routes](managed-http.md).
- Test your flows: [testing](recipes/testing.md).
