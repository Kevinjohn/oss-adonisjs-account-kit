# Require verified email on an application route

Add the Account Kit verification gate to an existing protected API route while keeping AdonisJS
Auth responsible for establishing the caller's identity. This recipe uses the API starter's opaque
`api` access-token guard; a session app must also pass its stored credential revision as shown in
[Browser login with sessions](sessions.md).

## Starting point and files

Start with an AdonisJS 7 API app that already has Account Kit's Lucid user adapter, email
verification enabled, and an `api` guard backed by `auth_access_tokens`. The user table must have
the package's verification and credential-revision columns. Add or reuse these files:

- `app/services/account_input.ts` to derive the signed-in user and token identifier from Auth.
- `app/middleware/verified_account_middleware.ts` to call `requireActive`.
- `start/kernel.ts` to register the named middleware.
- `start/routes.ts` to place the check after the native `auth` middleware.

The reference API app's
[account input](../../examples/api/app/services/account_input.ts),
[verified-account middleware](../../examples/api/app/middleware/verified_account_middleware.ts),
[kernel registration](../../examples/api/start/kernel.ts), and
[route order](../../examples/api/start/routes.ts) are the matching implementation.

## Add the gate after authentication

The middleware reads identity only from the selected AdonisJS guard and passes the opaque token
identifier to Account Kit. Never accept either value from a request body, query or route parameter.

```ts
// app/middleware/verified_account_middleware.ts
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import accountKit from 'adonisjs-account-kit/services/main'
import { accountInput } from '#services/account_input'

export default class VerifiedAccountMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    await accountKit.authentication.requireActive(accountInput(ctx))
    return next()
  }
}
```

Register the lazy middleware in `start/kernel.ts`, then apply the gates in this order:

```ts
router
  .get('/api/v1/reports', [ReportsController, 'index'])
  .use(middleware.auth())
  .use(middleware.verifiedAccount())
```

`auth()` first rejects or redirects a signed-out caller according to the application's guard
configuration. `requireActive` then checks the current credential revision and application
`canAccess` policy, and returns the package's `E_ACCOUNT_KIT_UNVERIFIED_EMAIL` 403 for a signed-in
account whose email is not confirmed. A confirmed, permitted account reaches the handler. If the
product deliberately allows a limited dashboard before verification, leave that route with
`auth()` plus `accountKit.authentication.current(...)` and reserve `verifiedAccount()` for the
restricted data or action.

## Verify all three states

Create one unverified account and one confirmed account in a disposable database. Exercise the
same real route as a guest, with the unverified account's token, and with the confirmed account's
token. Expect the native guard's guest response, the package's 403 for the unverified caller, and
the normal route result for the confirmed caller. Also change credentials or reset the unverified
account and confirm that its stale token is rejected by the route. The reference API's
[token-route tests](../../examples/api/tests/functional/token_reference.spec.ts) exercise the
unverified denial and current-credential checks; its
[session race tests](../../examples/api/tests/functional/session_guard_races.spec.ts) cover the
session variant.

This API example does not claim browser behavior, translated frontend form errors, or a Vue/Edge
integration. Keep messages and any guest redirect in the application; Account Kit supplies stable
error codes and the verification decision. See [AdonisJS Auth middleware](https://docs.adonisjs.com/guides/auth/introduction)
and the [authentication reference](../authentication.md) for the selected guard setup.

The disposable acceptance app was prepared from `examples/api` at starter revision `ae42132` with
`pnpm test:consumer -- --database=sqlite --prepare-only`. It ran Node `v24.21.0`, AdonisJS Core
`7.6.0`, Auth `10.1.0`, Lucid `22.4.2`, Vine `4.4.0`, and Account Kit `0.0.0` against SQLite;
the prepared app uses pnpm `10.21.0` (the packaging workspace uses pnpm `11.23.0`).

A disposable HTTP test mounted the route with native `auth()` followed by `verifiedAccount()` and
passed with `pnpm exec node ace test --files=tests/functional/recipe_verified_email_route.spec.ts`:
guest 401, unverified account 403, verified account 200. Removing `verifiedAccount()` changed the
unverified result to 200; restoring it returned the test green. This checks the API guard and
middleware only, not a browser redirect or localized frontend message. See the
[example acceptance record](../guides/example-acceptance.md).
