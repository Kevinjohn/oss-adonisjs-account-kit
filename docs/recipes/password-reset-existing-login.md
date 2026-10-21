# Add password reset to an existing API login

Use this when an AdonisJS API already signs people in with the Lucid access-token guard and you
want Account Kit to add password reset without taking over login. The example keeps the starter's
`api` guard and `auth_access_tokens` table. Session applications need the server-side store and
revision setup in [Browser login with sessions](sessions.md); they cannot use this token-guard
configuration unchanged.

## Starting point

Start with the AdonisJS 7 API starter, Node 24, pnpm, its existing `User.accessTokens` provider,
and login route. This recipe assumes Account Kit is installed and configured. With a published
package version installed, add its configuration and migrations with:

```sh
node ace add adonisjs-account-kit
node ace migration:run
```

The setup command adds the Lucid adapter and account configuration. Keep your existing login route,
auth middleware and token provider. The migration adds Account Kit's account columns and reset
proof table to the selected users table.

The current repository snapshot has no matching published package release. To prepare the same
kind of disposable app from this checkout, run `pnpm test:consumer -- --database=sqlite
--prepare-only` at the repository root. It installs a local packed archive into a disposable copy
of `examples/api`; this is a contributor verification path, not a published installation.

## Configure and mount only password reset

In the existing `config/account_kit.ts`, retain your users adapter and application policy, add
`passwordReset` to the enabled capabilities, and make the selected guard match the starter:

```ts
enabled: ['passwordReset'],
authentication: {
  strategy: 'access_tokens',
  guard: 'api',
  tokenTable: 'auth_access_tokens',
  canAccess: async (user, trx) => true, // replace with your restriction lookup
},
onCredentialsChangedTransaction: async () => {},
```

The empty credential callback is correct only when the application has no other sessions, API
keys or remember-me credentials to revoke. Add their transactional revocation there if your policy
requires it. Use your application's real policy in `canAccess`. For local work, configure
`createLogNotifications` as described by the [development mail recipe](development-mail.md), or
use `createMailNotifications` with configured AdonisJS Mail.

Add `start/account_kit_routes.ts` with a separate prefix so it cannot replace an existing starter
route. The example uses the package's public service and HTTP exports:

```ts
import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'
import { AccountKit } from 'adonisjs-account-kit'
import { createManagedGuard, registerManagedRoutes } from 'adonisjs-account-kit/http'

registerManagedRoutes(router, {
  prefix: '/account-kit',
  enabled: ['passwordReset'],
  kit: () => app.container.make(AccountKit),
  guard: createManagedGuard({
    strategy: 'access_tokens',
    name: 'api',
    loadUser: async () => (await import('#models/user')).default,
  }),
})
```

Import it after the starter's own routes in `start/routes.ts`:

```ts
import './account_kit_routes.js'
```

The request, proof inspection and completion routes are public; do not place this mount inside the
starter's `auth` route group. Wrap `managedProofHeadersMiddleware` in a default-exported Adonis
middleware class and register it in the early server stack before the body parser. Use the same
`/account-kit` prefix and `['passwordReset']` selection, so malformed proof requests also get
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`:

```ts
// app/middleware/account_kit_proof_headers_middleware.ts
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { managedProofHeadersMiddleware } from 'adonisjs-account-kit/http'

const proofHeaders = managedProofHeadersMiddleware({
  prefix: '/account-kit',
  strategy: 'access_tokens',
  enabled: ['passwordReset'],
})

export default class AccountKitProofHeadersMiddleware {
  handle(ctx: HttpContext, next: NextFn) {
    return proofHeaders(ctx, next)
  }
}
```

In `start/kernel.ts`, register the lazy class import before body parsing:

```ts
server.use([
  () => import('#middleware/account_kit_proof_headers_middleware'),
  // other global middleware
])
```

See [Managed JSON routes](../managed-http.md#inspection-never-consumes-proof). Point
`urls.passwordReset` in `config/account_kit.ts` at your application-owned password form; the
package does not generate that page.

## Verify the reset and revocation

Run migrations against a disposable database, start the app, sign in through the existing login,
and keep its bearer token. Request reset for a known and an unknown address; both must return the
same generic `202` acknowledgement. Copy the proof from your private development capture, GET the
proof route once or more to confirm inspection does not consume it, then POST the new password and
confirmation. The managed completion route returns `200 {"reset":true}`. The reset changes the stored
password and deletes every access-token row for that account.

The decisive revocation check is a request to a real route protected by the starter's normal auth
middleware using the saved pre-reset bearer value: it must now return `401`. Verify the new
password through the existing login route. A successful reset response alone does not prove that
the old credential ended. If the request is acknowledged but no proof is captured, check the
account exists in the selected database and that the generated throwing notification callback was
replaced.

The API starter uses the `api` guard and JSON responses. For a browser session app, follow the
[session recipe](sessions.md) and [managed HTTP session requirements](../managed-http.md); for
frontends, use their own form and field-error presentation. Application validation and public
wording remain owned by the application. The [reset controller](../../examples/api/app/controllers/password_resets_controller.ts),
[reset HTTP suite](../../examples/api/tests/functional/account_password_reset.spec.ts), and
[core API walkthrough](../guides/core-api.md) show the request, inspection, completion and
revocation boundaries in a runnable API app.

The disposable acceptance app used the repository's `examples/api` reference app at source revision
`ae42132` and was prepared with
`pnpm test:consumer -- --database=sqlite --prepare-only`. It ran Node `v24.21.0`, AdonisJS Core
`7.6.0`, Auth `10.1.0`, Lucid `22.4.2`, Vine `4.4.0`, and Account Kit `0.0.0` against SQLite;
the prepared app uses pnpm `10.21.0` (the packaging workspace uses pnpm `11.23.0`).

A temporary disposable-app HTTP test named `recipe_add_password_reset.spec.ts` mounted only
`passwordReset` at `/account-kit` and passed with
`pnpm exec node ace test --files=recipe_add_password_reset.spec.ts`: known and
unknown requests returned the same 202, reset completion succeeded, the pre-reset bearer received
401 on the starter's existing protected profile route, and the existing login rejected the old
password and accepted the new one. Removing credential-revision advancement and retaining tokens
made the protected request return 200; restoring the package and rerunning passed. This checks the
API route lifecycle, not a browser form or external mail delivery. See the
[example acceptance record](../guides/example-acceptance.md).
