# Add password reset to an existing Edge app

This recipe adds password reset to the pinned AdonisJS 7 Hypermedia starter while keeping its
`User` model, `/login` route, `web` guard, Edge layouts and account policy. Read the shared
[existing-app integration guide](../guides/password-reset-existing-app.md) first, then follow this
kit-specific walkthrough. Install Account Kit from the
[root install instructions](../../README.md#install).

## Keep the native application flow

Before installing the package, prove that the starter's existing login form signs in a seeded user
and that `/dashboard` is protected. Keep that controller, model, routes and forms as the base of
the integration. The committed recipe patch changes the existing login controller only to save the
credential revision returned by Account Kit; it does not replace the login route or the AdonisJS
`web` guard.

Run the configurator and inspect its generated inventory before adding test setup or browser
bootstrap code:

```sh
pnpm exec node ace configure adonisjs-account-kit
git status --short
```

The configurator creates `config/account_kit.ts`, Account Kit migrations and provider registration.
Keep those generated files out of a transplant patch. Add a migration for the starter's server-side
`sessions` table yourself if it has none; the starter's `config/session.ts` already supports the
database store. Set `SESSION_DRIVER=database` after applying that migration. The recipe retains
the starter's session cookie settings and native CSRF middleware.

## Add reset routes and forms

Add `GET` and `POST /forgot-password` routes for the reset request, and `GET` and `POST
/reset-password/:token` routes for proof inspection and completion. Keep reset routes public and
leave the existing login and dashboard routes in place. The Edge pages use the starter's
`@layouts.auth`, `@form`, field and button components. `@form` adds the Shield CSRF field; forms
submit ordinary browser POSTs and work with JavaScript disabled.

The request controller validates the email, calls `kit.passwordReset.request`, and returns the
same acknowledgement for known and unknown addresses. It logs delivery failures without changing
the response. The proof GET calls `kit.passwordReset.inspect` and never consumes a token. The
completion POST validates the new password twice, calls `kit.passwordReset.reset`, and uses
POST/redirect/GET for both success and recoverable failure. Set a same-origin referrer policy on
proof pages so the token is not sent as a referrer to cross-origin pages.

The starter's alert component normally uses `x-cloak`, which hides reset acknowledgements until
Alpine runs. Remove that cloak while keeping its `x-show` behavior so server-rendered success and
failure alerts remain visible when JavaScript is disabled. The signup controller also authenticates
through the same session adapter after creating the user; this saves the initial credential
revision while preserving the starter's signup form and dashboard redirect.

The login controller should call `kit.authentication.login` with the existing `web` guard adapter.
That adapter regenerates the native session, logs the user in through AdonisJS auth and stores the
credential revision. Register the revision middleware after Shield, auth initialization and silent
auth, before route authentication. On each request it checks the stored revision with
`kit.authentication.current`; a stale session is terminated so a protected dashboard request uses
the starter's existing redirect to `/login`.

Use the application's English copy and validation rules. The included failure policy retains safe
fields and clears both password inputs after validation errors. Keep password reset and session
behavior in the application; Account Kit supplies the proof and credential operations.

## Failure coverage

Every row below posts a form or submits the corresponding failed request and checks that the stored
password hash is unchanged. The malformed and expired cases are submitted using the CSRF token from
a valid native reset form, so they exercise the POST action in an ordinary no-JavaScript browser
context.

| Failure                 | Browser test                                                                                 | Expected result                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Malformed token         | `malformed and expired reset POSTs are rejected without changing credentials or proof state` | Redirect to recovery; password and active proof stay unchanged.                    |
| Expired token           | `malformed and expired reset POSTs are rejected without changing credentials or proof state` | Same rejection; password and active proof stay unchanged.                          |
| Consumed token          | `reset acknowledgement is generic and revokes both old sessions through the original login`  | A second preloaded form POST is rejected after the first reset consumes the proof. |
| Mismatched confirmation | `a mismatched reset submission clears password fields and preserves the current password`    | Field error; both password inputs clear; old credential remains valid.             |
| Replaced token          | `requesting a replacement reset link invalidates the first without changing credentials`     | The first proof's POST is rejected; the replacement remains active.                |

The journey test also signs in two independent browser sessions through the original `/login`
route, confirms both can load `/dashboard`, completes reset, confirms both now redirect to `/login`,
rejects the old password through `/login`, and accepts the new password through that same route.

Run the example's suite and the clean-starter recipe:

```sh
pnpm --dir examples/hypermedia test
pnpm test:recipe -- --recipe=hypermedia-password-reset
```

## Clean application check

P3 evidence is recorded after the pinned starter recipe passes. The check uses the pinned official
Hypermedia starter, AdonisJS 7, SQLite and local in-process notification capture. It does not send
email or verify PostgreSQL. The source revision, candidate archive digest, starter commit and
lockfile digest, exact commands, test result and retained scaffold path are included in the
acceptance record produced by `pnpm test:recipe`.

The expired-proof mutation check belongs to that retained scaffold: after the recipe passes, bypass
the installed package's expiry comparison in `build/session_registry-*.js` and rerun its printed
spec command. The expired POST must fail the test because the old password hash changes. Restore
the installed package from the same candidate archive, verify its SHA-256 is unchanged, and rerun
the spec to green before recording P7.
