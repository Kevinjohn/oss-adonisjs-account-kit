# Browser login with sessions

Use this when your frontend is served from the same site as the API, for example an Inertia app
or server-rendered pages.

## Requirements

- AdonisJS Auth with a session guard (here called `web`).
- `@adonisjs/session` with a **server-side store** such as `database` or `redis`. The cookie store
  is not supported: a copied cookie would keep working after logout.
- Shield CSRF protection.
- Remember-me tokens turned off, unless you revoke them yourself on credential changes.

## 1. Configure

```ts
// config/account_kit.ts
authentication: {
  strategy: 'session',
  guard: 'web',
  canAccess: async (user, trx) => true, // replace with your suspended-account check
},
onCredentialsChangedTransaction: async () => {},
```

On every credential change, Account Kit advances `users.credentials_changed_at`. Each session
stores the revision it signed in with, and older sessions are rejected on their next request.

## 2. Adapt the guard

```ts
// app/services/account_kit_guard.ts
import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'

export function accountKitSessionGuard(ctx: HttpContext) {
  const guard = ctx.auth.use('web')
  return {
    strategy: 'session' as const,
    name: 'web',
    async establish(userId: number | string, revision: string | null) {
      ctx.session.regenerate()
      await guard.login(await User.findOrFail(userId))
      ctx.session.put('accountKitRevision', revision ?? '')
      return undefined
    },
    async terminate() {
      await guard.logout()
      ctx.session.clear()
      ctx.session.regenerate()
    },
  }
}
```

## 3. Log in

```ts
import accountKit from 'adonisjs-account-kit/services/main'

const result = await accountKit.authentication.login(
  { email, password, clientKey: ctx.request.ip() },
  accountKitSessionGuard(ctx)
)
```

## 4. Check the revision on each request

Add middleware that passes the stored revision to Account Kit so stale sessions fail closed:

```ts
const revision = ctx.session.get('accountKitRevision')
const input = {
  userId: ctx.auth.use('web').getUserOrFail().id,
  // '' means "signed in before any credential change"; a missing value must fail closed.
  ...(revision === undefined ? {} : { revision: revision === '' ? null : revision }),
}
await accountKit.authentication.current(input) // or requireActive(input) for verified-only routes
```

The example's
[account access middleware](../../examples/api/app/middleware/account_access_middleware.ts) does
this; copy it, or let `account-kit:setup` generate one for you.

## Further reading

- [Authentication integration](../authentication.md)
- [Session reference](../session-reference.md): CSRF bootstrap and the full browser sequence.
