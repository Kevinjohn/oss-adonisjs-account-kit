# Add password reset to an existing API login

Use this when an AdonisJS API already signs people in with the Lucid access-token guard and you
want Account Kit to add password reset without taking over login. The example keeps the starter's
`api` guard and `auth_access_tokens` table. Session applications need the server-side store and
revision setup in [Browser login with sessions](sessions.md); they cannot use this token-guard
configuration unchanged.

Follow the [shared reset integration checklist](../guides/password-reset-existing-app.md) for
installation, the shared schema, application ownership and the full credential-proof contract.
This recipe supplies the opaque-token configuration and routes.

## Starting point

Start with the AdonisJS 7 API starter, Node 24, pnpm, its existing `User.accessTokens` provider,
and login route. Follow the [root install instructions](../../README.md#install) for the available
GitHub release archive, configuration and migrations. npm publication is still pending.

The setup command adds the Lucid adapter and account configuration. Keep your existing login route,
auth middleware and token provider. Configuration generates the shared account schema, including
account columns and proof tables; inspect all generated migrations before running them.

For contributor checks, `pnpm test:consumer -- --database=sqlite --prepare-only` installs a local
packed archive into a disposable copy of `examples/api`. That fixture already has Account Kit
integration; it is not an existing-application scaffold or released-consumer installation.

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

Use the committed [acceptance spec](../../examples/api/tests/recipes/api-password-reset.spec.ts)
and [hand-edit patch](patches/api-password-reset.patch). From the repository root, run:

```sh
pnpm test:recipe -- --recipe=api-password-reset --database=sqlite
```

For a previously packed candidate, supply both flags; the harness installs that archive without
building or packing another one:

```sh
pnpm test:recipe -- --recipe=api-password-reset --database=sqlite \
  --candidate-tarball=/absolute/path/adonisjs-account-kit.tgz \
  --candidate-revision=<source-commit>
```

The harness creates the pinned official API starter, commits its baseline, and proves the original
login can reach `/api/v1/account/profile` before installing Account Kit. It configures Limiter
with its supported database store, selects the runtime memory store for this test, configures
Account Kit, captures the generated-file inventory, and records a second checkpoint. The patch
contains only application hand edits against that post-configure checkpoint. It excludes generated
migrations, generated schema, dependencies, the lockfile and the archive.

The harness copies the spec into the disposable app’s functional suite and runs
`pnpm test --files=api-password-reset.spec.ts`. It prints the retained application, evidence JSON
and an exact replay command. The replay wrapper retains the generated local test environment and
Node executable, and removes inherited external database settings. Run the printed command from
any directory when checking a mutation; running the bare spec command with different environment
settings does not reproduce the recorded run.

The spec checks the following observable behavior:

- Two credentials obtained through `/api/v1/auth/login` each reach the original protected profile.
- Known and unknown reset requests receive the same generic `202` acknowledgement.
- Two GET inspections of a valid proof succeed without consuming it.
- Malformed, expired and mismatched submissions preserve the stored password hash and both
  credentials. The expired fixture inserts a proof row with a past `expires_at`.
- Replacing a live proof makes that proof fail without changing the password or either credential;
  its replacement completes successfully.
- Completion makes both earlier credentials receive `401` on the original protected profile,
  rejects the old password through the original login, and accepts the new password there.
- Replaying the consumed proof preserves the new hash and two newly issued working credentials.
- `node ace list:routes` exposes only the three reset endpoints beneath `/account-kit`.

For the mutation check, locate `advanceCredentialRevision` in the installed package's
`node_modules/adonisjs-account-kit/build/` JavaScript (the packed build uses a chunk filename).
Remove its `credentials_changed_at` update **and** skip its access-token deletion. Run the printed replay command and require an assertion failure
when an earlier credential still reaches the protected profile. Restore the installed archive and
rerun the same command to green. A success response or a token-row count alone does not prove
credential revocation.

## Clean application check

**Preliminary manual check, 22 October 2026.** This is a focused installed-application HTTP check;
it has not yet been run through the complete recipe harness. Full P6 acceptance and the P7 dual
mutation/restoration check remain pending. This record must be completed before declaring the
recipe accepted.

| Field                                    | Preliminary evidence                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package source revision                  | `124c7790730477c974529e11460b728b96deee1e`                                                                                                                   |
| Archive SHA-256                          | `38fd950b08990a95b780d3077ad65f3a98bb898cb858b7b2f9eaabaae236a3d2`                                                                                           |
| Creator / starter                        | `create-adonisjs` `3.4.0`; official API starter `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`                                                                   |
| Starter baseline / configured checkpoint | `145270d13bcc5da1022c2b02540ea7e61f34d7b7` / `077b92131c6eb4417c0116b9317a078ba974b652`                                                                      |
| Starter lockfile SHA-256                 | `8e460c40eb5f4434146cc653c565892d2581d4a29e8f1f1756a4bb500f1f3d0d`                                                                                           |
| Runtime / package manager                | Node `24.21.0`; pnpm `11.23.0`                                                                                                                               |
| Installed packages                       | Core `7.6.0`; Auth `10.1.0`; Lucid `22.4.2`; Limiter `3.0.1`; Vine `4.4.0`                                                                                   |
| Database                                 | Disposable local SQLite `3.53.4`; `better-sqlite3` `13.0.3`                                                                                                  |
| Notification mode                        | Local in-process callback capture; development recipe uses log notifications                                                                                 |
| Focused result                           | `the original login and both bearer credentials obey the complete reset lifecycle`: 1/1 passed in 2 seconds                                                  |
| Other checks                             | Installed application's `pnpm typecheck` and `pnpm lint` passed after migrations and formatting generated output; route listing showed three reset endpoints |
| Full harness / mutation                  | Pending; no P6 or P7 result claimed                                                                                                                          |

The starter was created outside the repository with:

```sh
pnpm create adonisjs@3.4.0 <directory> \
  --kit=github:adonisjs/starter-kits/api#46d235932e3eb6472a16b740fa0b47b5f69fc6fc \
  --pkg=pnpm
```

The creator did not initialize Git; the baseline was recorded with `git init`, `git add -A` and
`git commit -m starter`. Its original login and protected profile were exercised before Account
Kit installation. The focused check then used a separate clone of the configured checkpoint with
the hand edits applied. From that application's directory, the spec command was:

```sh
pnpm test --files=api-password-reset.spec.ts
```

The local test invocation enforced Node 24 and used `NODE_ENV=test`, `TZ=UTC`, `HOST=127.0.0.1`,
`PORT=41234`, `APP_URL=http://127.0.0.1:41234`, `SESSION_DRIVER=memory`, `LIMITER_STORE=memory`,
`LOG_LEVEL=silent` and a generated development `APP_KEY`. The final harness record will retain
these settings privately and print its reproducible replay command instead of relying on local
shell settings.

This API recipe supplies no frontend password form; production proof links must target an
application-owned reset form instead of the local JSON inspection URL.

Limits: local SQLite and local notification capture only; no recipient delivery, PostgreSQL,
browser form, viewport or keyboard acceptance is claimed. See the
[example evidence format](../guides/example-acceptance.md#updating-the-record).
