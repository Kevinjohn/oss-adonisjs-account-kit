# Build one account API

This path starts with the official AdonisJS 7 API starter and adds one application-owned
`/api/v1` account API. It uses the starter's opaque `api` guard and `auth_access_tokens` table.
Account Kit supplies registration, proof, authentication, and credential-change services; your
application owns routes, validation, response language, and who may use protected resources.

The journey is signup → confirm the email address → log in → read a protected profile → change
the password while retaining the calling token → reset the password and revoke every token.
Use fictional accounts and a disposable local database while following it. The shorter
[reset tutorial](../getting-started.md) remains useful if reset is all you need.

## 1. Create the app and install Account Kit

Use Node 24 and pnpm. Create the disposable API application in a separate directory:

```sh
pnpm create adonisjs@latest my-app --kit=api --pkg=pnpm
cd my-app
```

Follow the [root install instructions](../../README.md#install) to install the GitHub release
archive, configure Account Kit and run migrations. npm publication is still pending. For
contributor evaluation of unreleased changes, build and pack the checkout, install that local
archive instead, then run `node ace configure adonisjs-account-kit`. Record the source revision
and archive digest separately from released-consumer evidence. The
[verified-route recipe](../recipes/verified-email-route.md#verify-all-three-states) retains its
dated local-archive check; the rest of this tutorial has separately recorded HTTP journey evidence.

Choose the limiter's `database` store when prompted. Keep the starter's `api` guard, Lucid
`User.accessTokens` provider, and `auth_access_tokens` migration. Set a stable `APP_KEY` and
`APP_URL=http://localhost:3333` in `.env`. The package migration adds account columns and proof
tables to the starter's `users` table. If your application already has users, read
[identity creation](../identity-creation.md) before applying migrations.

## 2. Select this app's account policy and development mail

In generated `config/account_kit.ts`, keep the Lucid adapter and enabled capabilities. Replace
the existing `registration` and `onCredentialsChangedTransaction` entries, and add the password
and authentication entries, to select this integration:

```ts
registration: { availability: 'open' },
passwordPolicy: { minLength: 8, maxLength: 256 },
authentication: {
  strategy: 'access_tokens',
  guard: 'api',
  tokenTable: 'auth_access_tokens',
  tokenExpiresIn: '1d',
  tokenAbilities: ['*'],
  canAccess: async () => true,
},
onCredentialsChangedTransaction: async () => {},
```

This example deliberately allows public signup and every account through `canAccess`. Replace
both decisions with your application's admission and restriction policy before opening the API
to real users. The empty callback is correct only when there are no separate application-owned
credentials to revoke. `['*']` matches the starter; it grants no resource ownership or role.
Account Kit's token options govern **its** login below, while a remaining direct starter login
would use the starter's own issuance settings. Remove the starter signup/login routes in step 5
so there is only one credential path.

The generated config throws on notification until a mail transport is chosen. First create
`tests/helpers/account_mail.ts` for the integration test. This supported capture supplies every
notification callback required by the selected capabilities:

```ts
import { captureNotifications } from 'adonisjs-account-kit/testing/notifications'

export const accountMail = captureNotifications()
```

For local work, import `app` and `createLogNotifications` in `config/account_kit.ts`, remove the
generated `notConfigured` helper, and replace its `notify` block. Declare `testMailModule`
before `defineConfig` so only test runs load the capture:

```ts
import app from '@adonisjs/core/services/app'
import { createLogNotifications } from 'adonisjs-account-kit'

const testMailModule = app.inTest ? await import('#tests/helpers/account_mail') : null

// inside defineConfig:
notify: testMailModule
  ? testMailModule.accountMail.notify
  : createLogNotifications({
      brandName: 'My App',
      environment: app.inProduction ? 'production' : 'development',
    }),
```

The development server prints proof links. Never use log notifications in production or put
proof-bearing paths in shared access logs. Use [development mail](../recipes/development-mail.md)
for local choices and [notifications](../notifications.md) for a real delivery transport. A
production `APP_URL` must be HTTPS; configure trusted proxies before using `request.ip()` as a
limiter identity.

Replace the generated action-URL helper and `urls` block so **both** proof links stay in the
chosen namespace:

```ts
const baseUrl = env.get('APP_URL').endsWith('/') ? env.get('APP_URL') : env.get('APP_URL') + '/'
const actionUrl = (path: string, token: string) =>
  new URL(`api/v1/auth/${path}/${encodeURIComponent(token)}`, baseUrl).toString()

// inside defineConfig:
urls: {
  passwordReset: (token) => actionUrl('password-reset', token),
  emailVerification: (token) => actionUrl('verification', token),
  invitation: (token) => actionUrl('invitation', token),
  emailChange: (token) => actionUrl('email-change', token),
},
```

Keep the generated invitation authorization callbacks, which deny invitation management in this
walkthrough. Run `node ace account-kit:doctor`: its green installation checks and **Unverified**
summary do not claim that these routes, delivery, or revocation work. The requests below check
those behaviors.

## 3. Adapt the starter's opaque token guard

Create `app/services/account_kit_guard.ts`. Account Kit calls this adapter to issue a token
after login and to undo an issuance that raced a credential change:

```ts
import User from '#models/user'

export function accessTokenGuard() {
  return {
    strategy: 'access_tokens' as const,
    name: 'api',
    async establish(
      userId: number | string,
      abilities: string[],
      expiresIn: string | number | null
    ) {
      const user = await User.findOrFail(userId)
      const token = await User.accessTokens.create(
        user,
        abilities,
        expiresIn === null ? undefined : { expiresIn }
      )
      return { userId, identifier: token.identifier, value: token.value!.release() }
    },
    async terminate(credential?: {
      userId: number | string
      identifier: number | string | BigInt
      value: string
    }) {
      if (!credential) return
      const user = await User.findOrFail(credential.userId)
      await User.accessTokens.delete(user, credential.identifier)
    },
  }
}
```

The starter's `app/models/user.ts` already defines `User.accessTokens`; do not replace that
provider or add a second token table. See [authentication](../authentication.md) for other
guards and [access tokens](../recipes/access-tokens.md) for the adapter contract.

## 4. Validate fields and map known errors

Create `app/validators/account_journey.ts`. The 8–256 character policy matches step 2; a
validation error is the starter's normal 422 field envelope, while service proof and account
errors use the mapping below.

```ts
import vine from '@vinejs/vine'

const email = () => vine.string().trim().toLowerCase().email().maxLength(254)
const password = () => vine.string().minLength(8).maxLength(256)

export const signupValidator = vine.create({ email: email(), password: password() })
export const loginValidator = vine.create({ email: email(), password: vine.string().minLength(1) })
export const proofValidator = vine.create({ token: vine.string().minLength(1) })
export const newPasswordValidator = vine.create({
  password: password(),
  passwordConfirmation: vine.string().sameAs('password'),
})
export const recoveryRequestValidator = vine.create({ email: email() })
export const changePasswordValidator = vine.create({
  currentPassword: vine.string().minLength(1),
  newPassword: password(),
  newPasswordConfirmation: vine.string().sameAs('newPassword'),
})
```

In the starter's `app/exceptions/handler.ts`, add the mapping before its ordinary handler call:

```ts
import { accountErrorResponse } from 'adonisjs-account-kit'

// at the start of HttpExceptionHandler.handle(error, ctx):
const mapped = accountErrorResponse(error)
if (mapped) {
  for (const [name, value] of Object.entries(mapped.headers)) ctx.response.header(name, value)
  return ctx.response.status(mapped.status).send(mapped.body)
}
```

Keep the rest of the starter handler. Unknown errors still use AdonisJS reporting. The package
mapping does not replace Vine's field errors; your application can translate either response in
its own language. A committed failure needs special handling at the operation that knows what
was saved, as the controller does below. See [errors](../reference/errors.md).

## 5. Add the application-owned routes and operations

Create `app/controllers/account_journey_controller.ts`. No client-supplied user ID is trusted:
protected methods derive the actor and opaque token ID from the authenticated `api` guard.
`requireActive` adds the account revision, restriction, and verified-email gate to native guard
authentication. The password-change `keepCurrent` option retains only the calling token; reset
revokes all of the account's tokens.

```ts
import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'
import {
  DeliveryError,
  PostCommitError,
  RegistrationEmailAlreadyRegisteredError,
  passwordChangeRevision,
} from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import { accessTokenGuard } from '#services/account_kit_guard'
import {
  signupValidator,
  loginValidator,
  proofValidator,
  newPasswordValidator,
  recoveryRequestValidator,
  changePasswordValidator,
} from '#validators/account_journey'

const acknowledgement = { message: 'If the account exists, instructions will be sent.' }

function activeInput(ctx: HttpContext) {
  const user = ctx.auth.use('api').getUserOrFail()
  return { userId: user.id, tokenId: user.currentAccessToken?.identifier?.toString() }
}

function privateFault(ctx: HttpContext, error: DeliveryError | PostCommitError, operation: string) {
  ctx.logger.error({ code: error.code, operation }, 'account follow-up failed')
}

export default class AccountJourneyController {
  async signup(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(signupValidator)
    try {
      await accountKit.registration.register({ email, password })
    } catch (error) {
      if (error instanceof RegistrationEmailAlreadyRegisteredError)
        return ctx.response.unprocessableEntity({
          errors: [{ field: 'email', rule: 'unique', message: 'The email has already been taken' }],
        })
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      privateFault(ctx, error, 'signup')
      return ctx.response.accepted({
        accountCreated: true,
        message:
          'Account created. Request verification again after one minute if mail did not arrive.',
      })
    }
    return ctx.response.created({
      accountCreated: true,
      message: 'Check your email to confirm it.',
    })
  }

  async requestVerification(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(recoveryRequestValidator)
    const user = await User.findBy('email', email)
    if (user) {
      try {
        await accountKit.emailVerification.send({ userId: user.id })
      } catch (error) {
        if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
        privateFault(ctx, error, 'requestVerification')
      }
    }
    return ctx.response.accepted(acknowledgement)
  }

  async inspectVerification(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    const { token } = await ctx.request.validateUsing(proofValidator, { data: ctx.params })
    return ctx.response.ok({ valid: await accountKit.emailVerification.inspect({ token }) })
  }

  async verify(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    const { token } = await ctx.request.validateUsing(proofValidator, { data: ctx.params })
    const { password } = await ctx.request.validateUsing(newPasswordValidator)
    try {
      await accountKit.emailVerification.complete({ token, password })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      privateFault(ctx, error, 'verify')
    }
    return ctx.response.ok({
      verified: true,
      message: 'Email confirmed. Sign in with the new password.',
    })
  }

  async login(ctx: HttpContext) {
    const { email, password } = await ctx.request.validateUsing(loginValidator)
    const result = await accountKit.authentication.login(
      { email, password, clientKey: ctx.request.ip() },
      accessTokenGuard()
    )
    return ctx.response.ok({ user: result.account, token: result.credential.value })
  }

  async profile(ctx: HttpContext) {
    return ctx.response.ok(await accountKit.authentication.requireActive(activeInput(ctx)))
  }

  async changePassword(ctx: HttpContext) {
    const actor = activeInput(ctx)
    await accountKit.authentication.requireActive(actor)
    const { currentPassword, newPassword } =
      await ctx.request.validateUsing(changePasswordValidator)
    try {
      await accountKit.emailPasswordManagement.changePassword({
        actorId: actor.userId,
        currentPassword,
        newPassword,
        keepCurrent: actor.tokenId ? { tokenId: actor.tokenId } : {},
      })
    } catch (error) {
      if (!(error instanceof PostCommitError) || passwordChangeRevision(error) === undefined)
        throw error
      privateFault(ctx, error, 'changePassword')
    }
    return ctx.response.ok({ changed: true })
  }

  async requestRecovery(ctx: HttpContext) {
    const { email } = await ctx.request.validateUsing(recoveryRequestValidator)
    try {
      await accountKit.passwordReset.request({ email, clientKey: ctx.request.ip() })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      privateFault(ctx, error, 'requestRecovery')
    }
    return ctx.response.accepted(acknowledgement)
  }

  async inspectRecovery(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    const { token } = await ctx.request.validateUsing(proofValidator, { data: ctx.params })
    return ctx.response.ok({ valid: await accountKit.passwordReset.inspect({ token }) })
  }

  async completeRecovery(ctx: HttpContext) {
    ctx.response.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
    const { token } = await ctx.request.validateUsing(proofValidator, { data: ctx.params })
    const { password } = await ctx.request.validateUsing(newPasswordValidator)
    try {
      await accountKit.passwordReset.reset({ token, password })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      privateFault(ctx, error, 'completeRecovery')
    }
    return ctx.response.ok({ reset: true, message: 'Password reset. Sign in again.' })
  }
}
```

Add these bounded client-IP limiters to `start/limiter.ts`. Separate names keep signup,
verification, login, and password-reset budgets independent. Configure trusted proxies before
using the forwarded client address in production.

```ts
export const accountPublicLimit = (name: string) =>
  limiter.define(`account-${name}`, (ctx) =>
    limiter.allowRequests(5).every('15 minutes').usingKey(ctx.request.ip())
  )
```

Replace the starter's account routes in `start/routes.ts` with this single namespace. Keep the
starter's `middleware` and `router` imports; its old `controllers` import and direct signup,
login, profile, and logout route declarations can be removed. The named `auth` middleware is the
starter's native opaque-token gate; `requireActive` in the two protected methods adds Account
Kit's checks. The account and proof routes use no managed HTTP registration.

```ts
import { accountPublicLimit } from '#start/limiter'

const AccountJourneyController = () => import('#controllers/account_journey_controller')

router
  .group(() => {
    router
      .post('auth/signup', [AccountJourneyController, 'signup'])
      .use(accountPublicLimit('signup'))
    router
      .post('auth/request-verification', [AccountJourneyController, 'requestVerification'])
      .use(accountPublicLimit('request-verification'))
    router.get('auth/verification/:token', [AccountJourneyController, 'inspectVerification'])
    router
      .post('auth/verification/:token', [AccountJourneyController, 'verify'])
      .use(accountPublicLimit('verify'))
    router.post('auth/login', [AccountJourneyController, 'login']).use(accountPublicLimit('login'))
    router
      .post('auth/request-password-reset', [AccountJourneyController, 'requestRecovery'])
      .use(accountPublicLimit('request-password-reset'))
    router.get('auth/password-reset/:token', [AccountJourneyController, 'inspectRecovery'])
    router
      .post('auth/password-reset/:token', [AccountJourneyController, 'completeRecovery'])
      .use(accountPublicLimit('complete-password-reset'))

    router
      .group(() => {
        router.get('account/profile', [AccountJourneyController, 'profile'])
        router.post('account/password', [AccountJourneyController, 'changePassword'])
      })
      .use(middleware.auth({ guards: ['api'] }))
  })
  .prefix('/api/v1')
```

Remove the starter's old direct signup/login handlers from routing rather than leaving two
issuance policies exposed. The application can keep those source files unused or delete them in
its own cleanup. Preserve any unrelated routes in `start/routes.ts`.

## 6. Add a focused integration test

Create the functional-test directory first; the API starter may not contain it yet.

```sh
mkdir -p tests/functional
```

Inside the application’s `tests/functional` directory, create `core_account_journey.spec.ts`. The test sends real HTTP requests to
this starter, including a resend after the one-minute proof reuse window, and checks the actual
opaque credentials after both password changes. It uses only fictional data.

```ts
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { accountMail } from '#tests/helpers/account_mail'

const email = 'journey@example.test'
const initial = 'initial-password-123'
const confirmed = 'confirmed-password-123'
const settings = 'settings-password-123'
const reset = 'reset-password-123'
const verificationPath = () =>
  new URL(accountMail.last('accountActivationProvision', email)!.actionUrl!).pathname
const passwordResetPath = () =>
  new URL(accountMail.last('passwordResetProvision', email)!.actionUrl!).pathname

test.group('copied core API journey', (group) => {
  group.each.setup(async () => {
    const cleanup = await testUtils.db().truncate()
    await cleanup()
    await db
      .table('account_transaction_lock')
      .insert({ id: 1, version: 0 })
      .onConflict('id')
      .ignore()
    return cleanup
  })

  test('protects the profile and retains then revokes opaque tokens on credential changes', async ({
    client,
    assert,
  }) => {
    accountMail.clear()
    const invalid = await client.post('/api/v1/auth/signup').json({ email: '', password: initial })
    invalid.assertStatus(422)
    const signup = await client.post('/api/v1/auth/signup').json({ email, password: initial })
    signup.assertStatus(201)
    assert.isTrue(verificationPath().startsWith('/api/v1/auth/verification/'))
    const firstProof = accountMail.tokenFor('accountActivationProvision', email)
    const unknownResend = await client
      .post('/api/v1/auth/request-verification')
      .json({ email: 'unknown@example.test' })
    unknownResend.assertStatus(202)
    await db
      .from('email_verification_tokens')
      .where('email', email)
      .update({
        created_at: new Date(Date.now() - 61_000).toISOString(),
      })
    const resend = await client.post('/api/v1/auth/request-verification').json({ email })
    resend.assertStatus(202)
    assert.notEqual(accountMail.tokenFor('accountActivationProvision', email), firstProof)
    const inspect = await client.get(verificationPath())
    inspect.assertStatus(200)
    assert.isTrue((inspect.body() as { valid: boolean }).valid)
    const verification = await client
      .post(verificationPath())
      .json({ password: confirmed, passwordConfirmation: confirmed })
    verification.assertStatus(200)
    const replay = await client
      .post(verificationPath())
      .json({ password: confirmed, passwordConfirmation: confirmed })
    replay.assertStatus(422)

    const missingCredential = await client.get('/api/v1/account/profile')
    missingCredential.assertStatus(401)
    const first = await client.post('/api/v1/auth/login').json({ email, password: confirmed })
    first.assertStatus(200)
    const second = await client.post('/api/v1/auth/login').json({ email, password: confirmed })
    second.assertStatus(200)
    const tokenA = first.body().token as string
    const tokenB = second.body().token as string
    assert.isNotEmpty(tokenA)
    assert.isNotEmpty(tokenB)
    const profileA = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${tokenA}`)
    profileA.assertStatus(200)
    const profileB = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${tokenB}`)
    profileB.assertStatus(200)

    const shortPassword = await client
      .post('/api/v1/account/password')
      .header('Authorization', `Bearer ${tokenA}`)
      .json({
        currentPassword: confirmed,
        newPassword: 'short',
        newPasswordConfirmation: 'short',
      })
    shortPassword.assertStatus(422)
    const change = await client
      .post('/api/v1/account/password')
      .header('Authorization', `Bearer ${tokenA}`)
      .json({
        currentPassword: confirmed,
        newPassword: settings,
        newPasswordConfirmation: settings,
      })
    change.assertStatus(200)
    const retainedA = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${tokenA}`)
    retainedA.assertStatus(200)
    const revokedB = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${tokenB}`)
    revokedB.assertStatus(401)

    const request = await client.post('/api/v1/auth/request-password-reset').json({ email })
    request.assertStatus(202)
    assert.isTrue(passwordResetPath().startsWith('/api/v1/auth/password-reset/'))
    const complete = await client
      .post(passwordResetPath())
      .json({ password: reset, passwordConfirmation: reset })
    complete.assertStatus(200)
    const revokedA = await client
      .get('/api/v1/account/profile')
      .header('Authorization', `Bearer ${tokenA}`)
    revokedA.assertStatus(401)
    const oldLogin = await client.post('/api/v1/auth/login').json({ email, password: settings })
    oldLogin.assertStatus(400)
    const newLogin = await client.post('/api/v1/auth/login').json({ email, password: reset })
    newLogin.assertStatus(200)
  })
})
```

Run `node ace codegen`, `pnpm format`, `pnpm lint`, and `pnpm typecheck`, then
`node ace test functional --files=core_account_journey.spec.ts --timeout=15000`. Formatting also
normalizes generated config and migrations. The test needs the migrations from step 1.
Run migrations in the test database first if it differs from your development database.

## 7. Run the whole journey

Start the app with `node ace serve --hmr`. In another terminal, use the commands below. Copy
tokens and proof links privately from your local responses and development server log. Replace
angle-bracket placeholders with the actual values; never commit or share them.

| Step                  | Request                                                                                                                            | Expected result                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign up               | `POST /api/v1/auth/signup` with email and password                                                                                 | `201 {"accountCreated":true,...}`; a verification link is printed locally.                                                                                                    |
| Resend if mail failed | `POST /api/v1/auth/request-verification` with the same email after one minute                                                      | Generic `202`, then a new verification link is printed locally.                                                                                                               |
| Inspect and confirm   | `GET`, then `POST /api/v1/auth/verification/<proof>` with a new password and confirmation                                          | `200 {"valid":true}`, then `200 {"verified":true,...}`. The signup password is replaced.                                                                                      |
| Log in twice          | `POST /api/v1/auth/login` with the confirmed password                                                                              | Each `200` response has `user` and a different opaque `token`.                                                                                                                |
| Protected profile     | `GET /api/v1/account/profile` with each bearer token                                                                               | `200` with the active account; a missing token gets `401`.                                                                                                                    |
| Settings change       | `POST /api/v1/account/password` with one bearer token, old password, new password and confirmation                                 | `200 {"changed":true}`. The calling token stays valid; the second token fails with `401`.                                                                                     |
| Reset                 | `POST /api/v1/auth/request-password-reset`, then `POST /api/v1/auth/password-reset/<proof>` with another password and confirmation | Generic `202` request and `200 {"reset":true,...}` completion. The retained token now fails with `401`; only the reset password logs in. Invalid login gets the mapped `400`. |

For example, these are the actual shapes to send:

```sh
curl -i -X POST http://localhost:3333/api/v1/auth/signup -H 'content-type: application/json' \
  -d '{"email":"person@example.test","password":"initial-password-123"}'
# If initial delivery failed, wait one minute before requesting a new link:
curl -i -X POST http://localhost:3333/api/v1/auth/request-verification \
  -H 'content-type: application/json' -d '{"email":"person@example.test"}'
curl -i 'http://localhost:3333/api/v1/auth/verification/<proof>'
curl -i -X POST 'http://localhost:3333/api/v1/auth/verification/<proof>' \
  -H 'content-type: application/json' \
  -d '{"password":"confirmed-password-123","passwordConfirmation":"confirmed-password-123"}'
curl -i -X POST http://localhost:3333/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"person@example.test","password":"confirmed-password-123"}'
# Repeat login to obtain a second token for the retention check.
curl -i -X POST http://localhost:3333/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"person@example.test","password":"confirmed-password-123"}'
curl -i http://localhost:3333/api/v1/account/profile -H 'Authorization: Bearer <token-a>'
curl -i -X POST http://localhost:3333/api/v1/account/password \
  -H 'Authorization: Bearer <token-a>' -H 'content-type: application/json' \
  -d '{"currentPassword":"confirmed-password-123","newPassword":"settings-password-123","newPasswordConfirmation":"settings-password-123"}'
curl -i -X POST http://localhost:3333/api/v1/auth/request-password-reset \
  -H 'content-type: application/json' -d '{"email":"person@example.test"}'
curl -i 'http://localhost:3333/api/v1/auth/password-reset/<proof>'
curl -i -X POST 'http://localhost:3333/api/v1/auth/password-reset/<proof>' \
  -H 'content-type: application/json' \
  -d '{"password":"reset-password-123","passwordConfirmation":"reset-password-123"}'
```

Send a missing email to signup or a seven-character new password to the settings route to see
the starter's `422` field errors. A nonempty invalid or replayed proof gets the package's mapped
`422` code; a missing `:token` path segment is an ordinary route `404`. Requesting password reset for
an unknown address returns the same `202` body as a known address. If follow-up delivery fails
after a state change committed, the controller logs the failure privately and still reports what
was saved. A registration delivery failure returns `202` with guidance to call
`POST /api/v1/auth/request-verification` after the one-minute proof reuse window; that route
accepts a JSON email and gives the same `202` for unknown addresses. Do not retry a
committed change as if it rolled back.

The test that accompanies your application should exercise the protected route with two actual
opaque tokens: after the settings change, only the caller's token works; after reset, neither
does. It should also reject a missing token, invalid input, and replayed proof. The focused
HTTP test in step 6 runs that journey in the disposable starter. For a more complete API fixture with admission and social routes, see the [API example](../../examples/api/README.md).
