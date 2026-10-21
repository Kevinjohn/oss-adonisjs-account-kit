# Replace one managed endpoint

Keep Account Kit's selected managed routes while replacing one route with an application-owned
handler. This API recipe mounts under `/account-kit` so the starter's existing `/api/v1` routes stay
intact, then replaces the managed profile read within that mount.

## Starting point

Use the AdonisJS 7 API app with Account Kit configured, its `api` access-token guard, and the Lucid
`auth_access_tokens` provider. Keep the application's existing routes under `/api/v1`. Add
`start/account_kit_routes.ts`, import that mount from `start/routes.ts`, and add
`app/controllers/account_profile_controller.ts`. Keep the package capabilities needed by the
selected managed routes enabled in `config/account_kit.ts`. Reuse the application's named `auth`
and `accountAccess` middleware from [`start/kernel.ts`](../../examples/api/start/kernel.ts).

For session guards, first install the guarded server-side session configuration required by
[Managed JSON routes](../managed-http.md#configuration).

## Exclude one named route and add its replacement

Create the mount file with its service imports, lazy kit closure, guard, and selected routes. Exclude
only `account.profile.show`:

```ts
// start/account_kit_routes.ts
import app from '@adonisjs/core/services/app'
import router from '@adonisjs/core/services/router'
import { AccountKit } from 'adonisjs-account-kit'
import { createManagedGuard, registerManagedRoutes } from 'adonisjs-account-kit/http'
import { middleware } from '#start/kernel'
import AccountProfileController from '#controllers/account_profile_controller'

registerManagedRoutes(router, {
  prefix: '/account-kit',
  kit: () => app.container.make(AccountKit),
  guard: createManagedGuard({
    strategy: 'access_tokens',
    name: 'api',
    loadUser: async () => (await import('#models/user')).default,
  }),
  enabled: ['authentication', 'passwordReset', 'emailVerification', 'emailPasswordManagement'],
  except: ['account.profile.show'],
})

router
  .get('/account-kit/account/profile', [AccountProfileController, 'show'])
  .use(middleware.auth())
  .use(middleware.accountAccess())
```

Import the mount after the existing application routes in `start/routes.ts`:

```ts
import './account_kit_routes.js'
```

The access order is native `auth()` first, then `accountAccess()` for the current credential
revision and application restriction policy. This profile read is a `limited` route, so use
`accountAccess()` rather than the verified-email-only `verifiedAccount()` gate.

Project only public fields from the authenticated user; do not serialize the model wholesale:

```ts
export default class AccountProfileController {
  async show({ auth }: HttpContext) {
    const user = auth.use('api').getUserOrFail()
    return { id: user.id, email: user.email, fullName: user.fullName }
  }
}
```

The excluded route name is stable and listed in the [endpoint reference](../reference/endpoints.md).
Do not add `account.profile.show` to `enabled` separately; `except` removes that name from its
selected capability. Keep every other selected route enabled, and do not register the profile
path twice. The custom route uses the same `api` guard and Account Kit policy as the retained
managed operations.

## Verify the retained routes and lifecycle

Run `node ace list:routes`. `GET /account-kit/account/profile` must appear once; managed reset
request/inspect/complete, verification inspect/complete, profile update and password-change routes
must remain. Sign in through the starter's existing `/api/v1/auth/login`, then read the custom
profile route with its bearer token. Exercise the retained `/account-kit` reset route. After reset,
call the real custom profile route with the saved pre-reset bearer and expect `401`; call it with a
new login token to confirm the application handler still works. A success response alone does not
prove revocation. Also confirm a guest is rejected before the controller.

The API reference's [route-selection tests](../../tests/managed_routes.spec.ts), [managed proof
tests](../../tests/managed_http_proofs.spec.ts), and [token revocation HTTP
test](../../examples/api/tests/functional/account_password_reset.spec.ts) cover route planning,
proof headers and reset revocation. Those fixtures do not replace this disposable application
check. See [Managed JSON routes](../managed-http.md) and the
[example acceptance record](../guides/example-acceptance.md) for stack boundaries and evidence.

## Disposable acceptance

The disposable API app used the repository's `examples/api` reference app at source revision
`ae42132` and was prepared with
`pnpm test:consumer -- --database=sqlite --prepare-only`. It ran Node `v24.21.0`, AdonisJS Core
`7.6.0`, Auth `10.1.0`, Lucid `22.4.2`, Vine `4.4.0`, and Account Kit `0.0.0` against SQLite;
the prepared app uses pnpm `10.21.0` (the packaging workspace uses pnpm `11.23.0`).

`pnpm exec node ace list:routes` showed one custom `GET /account-kit/account/profile` plus managed
reset, verification, profile-update and password-change endpoints. The temporary disposable-app
HTTP test `recipe_replace_managed_endpoint.spec.ts` passed with
`pnpm exec node ace test --files=recipe_replace_managed_endpoint.spec.ts`:
the custom projection worked, managed reset revoked the saved bearer on that actual route, and a
new login worked. Removing credential-revision advancement and retaining tokens changed the
protected response from 401 to 200; restoring the package and rerunning passed. This checks API
routes, not a browser or external delivery. See the
[example acceptance record](../guides/example-acceptance.md).
