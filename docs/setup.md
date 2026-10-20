# Guided setup

This guide walks through `account-kit:setup` from the first preview to an active managed route
mount. The [setup choices reference](reference/setup-choices.md) lists every pillar field and
generated file; [how setup works](how-setup-works.md) explains the preview, recovery and readiness
model.

## Before you start

Setup is the alternative to `node ace add adonisjs-account-kit`, not a step after it. If
`config/account_kit.ts` or the package migrations already exist, setup marks each of them as a
conflict and `--apply` writes nothing.

1. Install the package without configuring it: `pnpm add adonisjs-account-kit`.
2. Add `() => import('adonisjs-account-kit/commands')` to the `commands` array in `adonisrc.ts`.
3. Install TypeScript 5.9.3 or newer 5.x, or 6.0.3 or newer 6.x, if the app does not have it:
   `pnpm add -D typescript@^5.9.3`. Setup reads your config files with it instead of running
   them. Other Account Kit entry points do not load TypeScript.
4. Check `config/auth.ts` for the guard you will use. Setup never creates a guard or changes the
   default one.
5. If you select authentication, create `app/services/account_kit_policy.ts` exporting
   `accountKitPolicy` with an async `canAccess(user, trx)` that returns whether the account may
   sign in. For an application with no restriction state, its complete minimal implementation is:

   ```ts
   // Shape illustration; use the typed, copyable module below in your application.
   export const accountKitPolicy = {
     canAccess: async (_user, _trx) => true,
   }
   ```

   Create `app/services/account_kit_policy.ts` with this typed, copyable form:

   ```ts
   import type { AccountUser, Trx } from 'adonisjs-account-kit'

   export const accountKitPolicy = {
     canAccess: async (_user: AccountUser, _trx: Trx) => true,
   }
   ```

   Returning `true` is an explicit application choice, not a safe universal default. If your app can
   suspend or otherwise restrict accounts, implement its actual rule in `canAccess`. This policy
   prerequisite remains mandatory whenever authentication is selected; setup does not generate an
   authorization policy.

## Run setup

Choose your answers interactively, or start from an example choices file:

- `node ace account-kit:setup` asks each question.
- `node ace account-kit:setup --input=choices.json` reads a copy of the
  [session example](setup_choices.example.json), which expects a `web` session guard, or the
  [API starter example](setup_choices.api.example.json), which expects an `api` access-tokens
  guard. Edit the guard name to match your app.

Both give the same typed choices. The command previews by default:

| Flag           | What it does                                                        |
| -------------- | ------------------------------------------------------------------- |
| (none)         | Prints the plan and writes nothing                                  |
| `--apply`      | Writes the plan, if it has no conflicts                             |
| `--check`      | Reads the saved choices and checks the current app, without writing |
| `--production` | Also checks public origins and session security for deployment      |

### Reconfigure saved choices

When you rerun the interactive wizard, valid saved choices seed the questions. Leave an answer
blank to keep its displayed value. Choices for capabilities you disable are cleared so the new
preview does not carry stale nested settings forward. Setup still previews the complete plan and
refuses to apply over owner-edited conflicts.

If the saved file is missing or invalid, the wizard explains that it is using starter defaults. To
preserve an earlier setup in that case, correct or remove `config/account_kit_setup.json`, or pass a
reviewed, valid choices file with `--input=choices.json`. An explicit `--input` always takes
precedence and does not start the interview; `--check` reads saved choices without prompting.

![Recording of account-kit:setup previewing and applying an earlier 13-migration inventory](assets/demos/setup.svg)

This recording predates the current migration inventory. A fresh setup currently generates 11
migrations.

The generated migrations assume the application users table already exists. On a fresh application,
create that table with the application's own migration before running Account Kit migrations. The
package adds nullable account and verification columns to that table and makes `password` nullable;
it does not create the users table or infer verification state for existing rows. See the
[identity creation guide](identity-creation.md) for the expected fields and the owner checklist for
existing accounts. Rows with `unverified_email = null` are treated as active, so decide how legacy
verification state should be represented before enabling account flows.

The first apply leaves the managed routes switched off. Keep
`authentication.applicationRouteRevocation` false for it:

1. Run `--apply`. It writes the config, the guard adapter, the account-access middleware and a
   managed route file that mounts nothing yet.
2. Review the generated migrations and run them.
3. Prove that a credential change signs out an old session or token on one of your own routes,
   as described below.
4. Set `applicationRouteRevocation` true and run `--apply` again. This switches the managed routes
   on.

A generated file or a passing typecheck does not show that revocation works at runtime. Setup keeps
reporting workflow verification as incomplete until you have exercised the flows.

### Prove revocation before route activation

The first apply writes three files you use here:

- `config/account_kit.ts` for the selected service policy.
- `app/services/account_kit_guard.ts`, exporting `accountKitGuard` for the existing named guard.
- `app/middleware/account_kit_access_middleware.ts` for your own routes.

Wire them up:

1. Register the generated middleware in the named middleware map in `start/kernel.ts`.
2. Attach it to a temporary protected route of your own, outside the managed prefix. The example
   [kernel](../examples/api/start/kernel.ts) and [profile route](../examples/api/start/routes.ts)
   show where; use `#middleware/account_kit_access_middleware` in place of the example's
   `#middleware/account_access_middleware`.
3. Keep a login route of your own while the managed routes are off. In it, resolve the service with
   `const kit = await app.container.make(AccountKit)` (`AccountKit` comes from
   `adonisjs-account-kit`) and call
   `kit.authentication.login({ email, password, clientKey: request.ip() }, accountKitGuard.forRequest(ctx))`.
   The generated guard adapter creates the real session or token and records the credential
   revision Account Kit checks later.
   - For tokens, return `accountKitGuard.publicCredential(result.credential)` as the bearer value.
   - For sessions, keep the regenerated HTTP-only session cookie.

   Adapt the example [token](../examples/api/app/controllers/access_tokens_controller.ts) or
   [session](../examples/api/app/controllers/session_controller.ts) login controller; the
   [guard example](../examples/api/app/services/account_kit_guards.ts) shows the same adapter
   behavior. Logging in through the native guard, or with a test helper such as `loginAs`, does
   not record the revision.

Then run the check:

1. Create a test account with a known password through your model or a fixture. It must pass your
   access policy, and have a verified email if verification is required.
2. Log in and call the protected route with the new credential. It must succeed.
3. Change the account's credentials through one of the operations your choices selected:
   - With `emailPasswordManagement`, change the password with
     `kit.emailPasswordManagement.changePassword({ actorId, currentPassword, newPassword })`, as
     in the example [password controller](../examples/api/app/controllers/account_password_controller.ts).
   - With `passwordReset` but not `emailPasswordManagement`, request a reset with
     `kit.passwordReset.request({ email, clientKey })`, take the link from your notification
     callback, and complete it with `kit.passwordReset.reset({ token, password })`, as in the
     example [reset controller](../examples/api/app/controllers/password_resets_controller.ts) and
     [reset test](../examples/api/tests/functional/bearer_revocation.spec.ts).
   - With authentication alone, restrict the account with
     `kit.authentication.changeRestriction({ userId, change })`, which updates your access-policy
     state in its transaction, then call it again to restore access. The
     [session restriction test](../examples/api/tests/functional/session_guard_races.spec.ts)
     and [service test](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/tests/authentication.spec.ts)
     show both calls. After restoring, log in again: the fresh credential must succeed on the
     protected route.
4. Call the same protected route with the **original** credential. It must get a 401.

Record the first success and the later 401, and for a restriction also the fresh credential's
success. A credential that was never accepted, or a request refused only while the account is
still restricted, proves nothing about revocation: everything is being refused.

How to send the credential:

- **Tokens**: send it as `Authorization: Bearer …`. The example
  [revocation test](../examples/api/tests/functional/token_reference.spec.ts) shows the
  password-change version.
- **Sessions**: while the managed routes are off, add a CSRF bootstrap route of your own, like the
  example [session controller's `csrf` method](../examples/api/app/controllers/session_controller.ts)
  and its [route](../examples/api/start/routes.ts). Fetch the CSRF token before login, keep the
  cookie through login and the protected request, send `x-csrf-token` on login and every
  state-changing request, then retry the protected route with the original cookie. The example
  [session test](../examples/api/tests/functional/session_guard_races.spec.ts) shows the
  sequence. The session store must be server-side. The setup report names the managed CSRF
  endpoint only once it is switched on; if you exclude it, keep your own bootstrap route.

These checks test your app's integration. The setup report reads files and cannot vouch for them.

### Use your own notification transport

To send account emails through your own transport instead of AdonisJS Mail:

1. In your choices, set `mail.integration` to `custom`, and `mail.senderEnv` and
   `mail.transportEnv` to `null`.
2. Create `app/services/account_kit_notifications.ts` exporting
   `accountKitNotifications: Partial<NotificationCallbacks>` (the type comes from
   `adonisjs-account-kit`).
3. Implement the callbacks your services need:
   - The example choices files select five services and need `passwordResetProvision`,
     `accountActivationProvision`, `emailChangeProvision`, `emailChanged`,
     `passwordResetCompleted` and `passwordChanged`.
   - Invitations also need `invitationProvision`.
   - `magicLinkLogin` needs `magicLinkProvision`, an existing guard and a `magicLink` destination
     (default `account/magic-link`); see [magic-link sign-in](magic-link.md).

Provision callbacks receive an action URL and must hand it to a real delivery transport.
`delivery: durable` also needs a queue or outbox of your own, with a verified worker, retries and
handling for messages that finally fail.

The callback below writes a **development-only** capture file so you can inspect links locally. It
is not mail delivery: do not commit the file, and replace `capture` with your real delivery before
deployment. Parameter types come from `NotificationCallbacks`:

- Provision callbacks get `(user, url)`, except invitations `(invitation, url)` and email change
  `(user, newEmail, url)`.
- `emailChanged` gets `(previousEmail, user)`; the password notices get `(user, context)`.

```ts
// app/services/account_kit_notifications.ts
import { open, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import app from '@adonisjs/core/services/app'
import type { NotificationCallbacks } from 'adonisjs-account-kit'

async function capture(kind: keyof NotificationCallbacks, recipient: string, url?: string) {
  if (app.inProduction) throw new Error('Configure account message delivery before production')
  const path = app.makePath('tmp', 'account-kit-notifications.jsonl')
  await mkdir(dirname(path), { recursive: true })
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  )
  try {
    if (!(await file.stat()).isFile()) throw new Error('Capture path must be a regular file')
    await file.chmod(0o600) // Also tighten permissions when the file already exists.
    await file.writeFile(JSON.stringify({ kind, recipient, url }) + '\n')
  } finally {
    await file.close()
  }
}

export const accountKitNotifications: NotificationCallbacks = {
  passwordResetProvision: (user, url) => capture('passwordResetProvision', user.email, url),
  accountActivationProvision: (user, url) =>
    capture('accountActivationProvision', user.unverifiedEmail ?? user.email, url),
  invitationProvision: (invitation, url) => capture('invitationProvision', invitation.email, url),
  emailChangeProvision: (_user, newEmail, url) => capture('emailChangeProvision', newEmail, url),
  emailChanged: (previousEmail, _user) => capture('emailChanged', previousEmail),
  passwordResetCompleted: (user, _context) => capture('passwordResetCompleted', user.email),
  passwordChanged: (user, _context) => capture('passwordChanged', user.email),
}
```

## After setup

1. Install any packages the report lists as missing; setup does not install dependencies. If
   `@adonisjs/limiter` is missing, also run `node ace configure @adonisjs/limiter`, then check
   that its provider is registered and `config/limiter.ts` selects a configured store.
2. Review the migrations and run `node ace migration:run` in your deployment window. Starting the
   app does not run migrations.
3. Review the generated route file and configure the selected guard's model. Implement your
   notification callbacks or configure AdonisJS Mail. Managed endpoints need no controller of
   your own.
4. Supply and check the rest of your integration:
   - Deployment environment values, the users adapter and model, invitation permission, the
     restricted-account policy, and the frontend pages that collect passwords or complete email
     links.
   - Attach the generated account-access middleware to your own protected routes too, so
     credential changes sign people out there as well.
5. For a **session** guard:
   - Use a configured server-side session store, run its table migration if it is the database
     store, and check that logout rejects a replay of the old cookie. Cookie-only storage cannot
     enforce this revocation.
   - Managed sessions need `protectManagedSessionConfig` in `config/session.ts` before
     SessionMiddleware starts. Setup wires this for a conventional database or development memory
     store. With a custom config or store, add the helper yourself with a verifier that proves
     destroy and revocation on the store you actually use; checking that a method exists is not
     enough.
   - Check cookie security, the CSRF bootstrap, trusted origins and proxies, and session
     persistence. If Shield enables CSRF conditionally, set the condition for the selected session
     guard (the example uses `ACCOUNT_KIT_AUTH_STRATEGY=session`), then call the CSRF bootstrap and
     a protected POST against the running app. Registering the middleware does not prove CSRF is
     on.
6. For a **token** guard, check issuance, lifetime, abilities, revocation and how clients store
   the token.
7. When social sign-in is selected:
   - Install and configure Ally, register each exact callback URL in the provider's console, and
     supply credential environment values for the selected providers only. Review any existing Ally
     config yourself.
   - For token clients, check that the client forwards the provider callback.
   - Exercise matching email, missing email, closed registration, linking, unlinking and PKCE
     replay. Also exercise the social-only account path: set a first password through password
     reset, sign in with it, then re-enter it.
   - Retire a provider only after a read-only inventory shows every affected account keeps another
     way to sign in.
8. Run `node ace account-kit:setup --check --production` after the application integration and exercise the selected workflows over HTTP. The command's static report cannot substitute for those end-to-end checks.
