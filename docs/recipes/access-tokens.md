# API-only login with access tokens

Use this for mobile apps, SPAs on another domain, or any client that sends
`Authorization: Bearer <token>`.

## 1. Configure the guard

You need AdonisJS Auth with the opaque access-token guard and its `auth_access_tokens` table. The
API starter kit has both. Point Account Kit at the existing guard:

```ts
// config/account_kit.ts
authentication: {
  strategy: 'access_tokens',
  guard: 'api',
  tokenTable: 'auth_access_tokens',
  tokenExpiresIn: '30d',
  tokenAbilities: ['*'],
  canAccess: async () => true, // replace with your application restriction lookup
},
onCredentialsChangedTransaction: async () => {},
```

The starter's `User.accessTokens` provider uses `auth_access_tokens`. With `access_tokens`, a
password reset deletes all of that user's rows in the configured `tokenTable` inside the password
transaction; the starter's protected `api` routes then reject previously issued bearer values.
Password change and confirmed email change use the same revision policy. The example `canAccess`
allows every account through Account Kit authentication calls. The unchanged starter login and
`api` middleware use their own checks, so enforce suspension there separately if needed.
`tokenExpiresIn` and `tokenAbilities` configure Account Kit token issuance, not the starter's
direct token issuance.
The empty `onCredentialsChangedTransaction` is appropriate only if the application holds no other
credentials. Revoke application-owned sessions, remember-me credentials or API keys in that
callback using its transaction when your policy requires them to end on a credential change.
The [reset tutorial](../getting-started.md) exercises two starter tokens across a reset.

## 2. Adapt the guard

Account Kit establishes and terminates tokens through a small adapter, so it can undo a login that
raced with a password change:

```ts
// app/services/account_kit_guard.ts
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
    }) {
      if (!credential) return
      const user = await User.findOrFail(credential.userId)
      await User.accessTokens.delete(user, credential.identifier)
    },
  }
}
```

## 3. Log in and out

```ts
// app/controllers/access_tokens_controller.ts
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { AccountKit } from 'adonisjs-account-kit'
import User from '#models/user'
import { accessTokenGuard } from '#services/account_kit_guard'

export default class AccessTokensController {
  async store({ request }: HttpContext) {
    const { email, password } = request.only(['email', 'password'])
    const kit = await app.container.make(AccountKit)
    const result = await kit.authentication.login(
      { email, password, clientKey: request.ip() },
      accessTokenGuard()
    )
    return { user: result.account, token: result.credential.value }
  }

  async destroy({ auth }: HttpContext) {
    const user = auth.use('api').getUserOrFail()
    const kit = await app.container.make(AccountKit)
    await kit.authentication.logout({
      async terminate() {
        if (user.currentAccessToken)
          await User.accessTokens.delete(user, user.currentAccessToken.identifier)
      },
    })
    return { message: 'Logged out' }
  }
}
```

Failed logins throw `InvalidCredentialsError` with one generic message for every cause. Map it to
401 in your exception handler; see the [error reference](../reference/errors.md).

## 4. Protect routes

Use the normal `auth` middleware for authentication. Then confirm the token is still bound to the
account, and for routes that need a confirmed email, that the account is active:

```ts
const user = auth.use('api').getUserOrFail()
const input = { userId: user.id, tokenId: user.currentAccessToken?.identifier?.toString() }
await kit.authentication.current(input) // signed in, any account
await kit.authentication.requireActive(input) // signed in and email confirmed
```

The example's
[verified account middleware](../../examples/api/app/middleware/verified_account_middleware.ts)
wraps this.
Check abilities on privileged routes with `user.currentAccessToken.allows('invitations:create')`.

## Further reading

- [Authentication integration](../authentication.md): limits, revision checks and logout details.
- [Token API reference](../token-reference.md): the full request sequence of the example app.
