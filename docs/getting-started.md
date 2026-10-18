# Getting started

This tutorial adds a working forgot-password flow to an AdonisJS 7 API application in about ten
minutes. You will install the package, generate its config and migrations, add two routes, and see
the reset link in your terminal.

## Before you start

You need:

- Node.js 24 or newer.
- An AdonisJS 7 application with Lucid and a `users` table. The API starter kit has both:

  ```sh
  npm init adonisjs@latest my-app -- --kit=api
  ```

- A stable `APP_KEY` of at least 32 characters and an `APP_URL` in `.env`.

## 1. Install

Account Kit uses `@adonisjs/limiter` for rate limits. Add it first, then add Account Kit:

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
@beforeSave()
static normalizeEmail(user: User) {
  user.email = user.email.trim().toLowerCase()
}
```

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

The generated config also asks you to choose a credential-revocation policy. Until you add
login, replace the throwing `onCredentialsChangedTransaction` with a no-op:

```ts
onCredentialsChangedTransaction: async () => {},
```

[Sessions](recipes/sessions.md) and [access tokens](recipes/access-tokens.md) explain what to put
there once users can sign in.

## 4. Check the installation

```sh
node ace account-kit:doctor
```

Every line should be green. A red line names the step that fixes it.

## 5. Add the routes

Create a controller:

```ts
// app/controllers/password_resets_controller.ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit, DeliveryError, InvalidTokenError, PostCommitError } from 'adonisjs-account-kit'

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

  async complete({ request, response, params }: HttpContext) {
    const kit = await app.container.make(AccountKit)
    try {
      await kit.passwordReset.reset({ token: params.token, password: request.input('password') })
      return response.ok({ message: 'Password reset.' })
    } catch (error) {
      if (error instanceof InvalidTokenError)
        return response.unprocessableEntity({ message: 'This link is invalid or has expired.' })
      throw error
    }
  }
}
```

Register the routes:

```ts
// start/routes.ts
const PasswordResetsController = () => import('#controllers/password_resets_controller')

router.post('account-kit/recovery', [PasswordResetsController, 'request'])
router.post('account-kit/recovery/:token', [PasswordResetsController, 'complete'])
```

The paths match the `urls.passwordReset` builder in the generated config, which produces links
of the form `APP_URL/account-kit/recovery/<token>`. In a real application that link points at
your frontend page, which then posts the new password to the API.

## 6. Try it

Start the server and request a reset for an existing user:

```sh
node ace serve --hmr
curl -X POST http://localhost:3333/account-kit/recovery -H 'content-type: application/json' \
  -d '{"email":"someone@example.com"}'
```

The terminal running the server prints the email, including a line like
`Reset password: http://localhost:3333/account-kit/recovery/<token>`. Complete the reset with that
token:

```sh
curl -X POST http://localhost:3333/account-kit/recovery/<token> \
  -H 'content-type: application/json' -d '{"password":"a-new-long-password"}'
```

Posting the same token again returns the invalid-link response: proofs work once.

## Next steps

- Validate request bodies with VineJS and map errors centrally: see
  [application-owned integration](application-owned-integration.md) and the
  [error reference](reference/errors.md).
- Send real email: [notifications](notifications.md) and
  [custom email templates](recipes/email-templates.md).
- Add login, verification and invitations: the [recipes](README.md#how-to-guides).
- Prefer not to write controllers? Mount the [managed JSON routes](managed-http.md).
- Test your flows: [testing](recipes/testing.md).
