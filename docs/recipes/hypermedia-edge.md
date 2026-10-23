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
Keep the generated provider and Account Kit migrations; adapt the generated config in place for the
starter's native session guard, reset URLs and application-owned notification callbacks. The recipe
patch does not add generated files. Add a migration for the starter's server-side `sessions` table
yourself if it has none; the starter's `config/session.ts` already supports the database store. Set
`SESSION_DRIVER=database` after applying that migration. The recipe retains the starter's session
cookie settings and native CSRF middleware.

## Add reset routes and forms

Add `GET` and `POST /forgot-password` routes for the reset request, and `GET` and `POST
/reset-password/:token` routes for proof inspection and completion. Keep reset routes public and
leave the existing login and dashboard routes in place. The Edge pages use the starter's
`@layouts.auth`, `@form`, field and button components. `@form` adds the Shield CSRF field; forms
submit ordinary browser POSTs and work with JavaScript disabled.

The request controller validates the email, calls `kit.passwordReset.request`, and returns the
same acknowledgement for known and unknown addresses. It logs delivery failures without changing
the response. The proof GET calls `kit.passwordReset.inspect` and never consumes a token. A narrow
server middleware matches only `/reset-password/:token` and sets `Cache-Control: no-store` and
`Referrer-Policy: no-referrer` before body parsing and CSRF checks, so malformed requests and error
responses carry the same privacy headers. The completion POST validates the new password twice,
calls `kit.passwordReset.reset`, and uses POST/redirect/GET for both success and recoverable failure.
Validation failures flash field errors without password input and return explicitly to the encoded
reset URL: `no-referrer` deliberately removes the header that a default redirect-back would need.

The starter's alert component normally uses `x-cloak`, which hides reset acknowledgements until
Alpine runs. Remove that cloak while keeping its `x-show` behavior so server-rendered success and
failure alerts remain visible when JavaScript is disabled. The signup controller also authenticates
through the same session adapter after creating the user; this saves the initial credential
revision while preserving the starter's signup form and dashboard redirect. The patch also trims
and lowercases the starter's shared email rule in `app/validators/user.ts`, because Account Kit
looks addresses up in that form; normalize existing addresses before enabling the recipe.

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
context in the clean-starter recipe spec. The table names the corresponding reference-example
tests; the clean-starter spec supplies the JavaScript-disabled malformed/expired POST coverage.

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

Verified on 22 October 2026. Apply the [hand-written patch](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/docs/recipes/patches/hypermedia-password-reset.patch)
after configuration; the [acceptance spec](../../examples/hypermedia/tests/recipes/hypermedia-password-reset.spec.ts)
uses the pinned starter's native login, dashboard, forms and CSRF protection. The scaffold command is:

```sh
pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/hypermedia#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm
```

The generated manifest uses `@adonisjs/core` `^7.5.2`, `@adonisjs/auth` `^10.1.0`,
`@adonisjs/lucid` `^22.4.2`, `@adonisjs/session` `^8.1.0`, `@adonisjs/shield` `^9.0.0`,
`@vinejs/vine` `^4.4.0`, `edge.js` `^6.5.1`, `@japa/browser-client` `^2.3.0`, and
`@japa/runner` `^5.3.0`. See the [complete pinned starter manifest](https://github.com/adonisjs/starter-kits/blob/46d235932e3eb6472a16b740fa0b47b5f69fc6fc/hypermedia/package.json).
Its pre-install lockfile SHA-256 was
`15448961b3b6caa132cbe17fe3ec0b5c4a044694eebb4221815ddb1fbad74bea`. Manual Git initialization
produced starter commit `4e5f3b4379e0d2f0b945281a8b7fb073260fdb7e`; the original native-login
check passed 1/1 in 328 ms before Account Kit installation. Configuration was recorded at
`f5e67a9b6b0adb3686b69a049d6b4ec1879707ef` before the patch was applied.

At clean source revision `64cf1a2dc17dd2b3b52e9b43a0ced6398e180668`, the fresh recipe passed
4/4 in 4 seconds. It checked signup auto-login, two native pre-reset sessions, protected-route
rejection of both old sessions, old-password rejection and new-password login. The failure cases
checked malformed, expired, consumed, mismatched and replaced proofs; the malformed/expired cases
preserved both account hashes and the exact expired and valid proof rows. JavaScript was disabled
for these recipe journeys. The mismatch response also carried both privacy headers and returned a
visible field error with both password inputs cleared.

The run used Node 24.21.0, pnpm 11.23.0, AdonisJS Core 7.6.0 and SQLite 3.53.4. The installed
package was an unpublished development archive, version 0.1.1, built from
`402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf`, SHA-256
`fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`. The archive digest was
unchanged after the run. Released archive installation is described in the
[root instructions](../../README.md#install). The exact recipe command was:

```sh
pnpm test:recipe -- --recipe=hypermedia-password-reset --candidate-tarball=/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-RukBcO/candidate/adonisjs-account-kit-0.1.1.tgz --candidate-revision=402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf
```

Retained evidence and command outputs are in
`/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-cK1p2i/evidence.json`.
The printed command preserves the harness's test environment when repeating the spec:

```sh
"/Users/kevinjohngallagher/.nvm/versions/node/v24.21.0/bin/node" "/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-cK1p2i/rerun.mjs"
```

The reference example at source `bce6c05f5ba663f4bfda284d3fd12c5226bb4433` passed
`pnpm test` 13/13 in 14 seconds, plus `pnpm lint`, `pnpm typecheck` and `pnpm build`.
For P7, only the installed reference-example package under
`examples/hypermedia/node_modules/adonisjs-account-kit/build/session_registry-*.js` was changed:
the expiry predicate and its corresponding binding were temporarily removed from the SQLite
proof-consumption query. Running the following command from `examples/hypermedia` failed 1/1
in 778 ms on an explicit password-hash mismatch after the expired POST:

```sh
pnpm test --files=account_journey.spec.ts --tests='malformed and expired reset POSTs are rejected without changing credentials or proof state'
```

The original vendor archive was reinstalled; its digest and installed member were checked against
the original bytes. The same command then passed 1/1 in 991 ms. The candidate archive itself was
never changed. These tests capture notifications in process and prove link generation and
application behavior; they do not establish recipient delivery, PostgreSQL behavior, or a new
manual viewport and keyboard inspection.

The shared P7 check was also run after the green P6 result in retained scaffold
`account-kit-recipe-cK1p2i`, using the printed command above. Bypassing only its installed expiry
predicate produced 3 passing tests and one explicit password-hash assertion failure in 4 seconds.
Restoring the exact archive member and checking its digest returned that same command to 4/4
passing in 4 seconds. The reference-example expiry check and this retained-scaffold check both
used the unchanged candidate archive recorded above.

### Failure-state correction — 23 October 2026

Source `6eb25e782712622caf3bb73ffbbd885685c26e32` adds live native-session checks before and
after malformed, expired, mismatched, replaced and consumed proof rejection. Mismatch and
replacement cases compare the exact stored password hash and replacement proof row, selected by
its SHA-256 hash. Consumed-proof replay uses a separately preloaded form, then verifies that a
session established with the new password still reaches the protected dashboard. The two original
sessions must already have been rejected before this replay check.

The fresh `pnpm test:recipe -- --recipe=hypermedia-password-reset` run passed 4/4 with JavaScript
disabled. Its P1 baseline is `46b5eee2a85b468d67592e99b910ce815294e29f`, configured checkpoint
`07f861ece93e9df6d3268ea028ab62ccc71e000e`, and lockfile SHA-256
`15448961b3b6caa132cbe17fe3ec0b5c4a044694eebb4221815ddb1fbad74bea`. Creator, starter, runtime,
database and archive versions/digests match the record above. The retained record is
`/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-Tq2stW/evidence.json`;
its printed rerun command invokes that directory's `rerun.mjs` with Node 24.21.0.

The first strengthened recipe run exposed a test-fixture problem: checking the revoked session
also invalidated the CSRF state in its preloaded form. Giving consumed-proof replay an independent
browser context corrected the fixture; the final fresh run above includes this correction. No
application handler or package code was changed.

The final reference application's `pnpm test` passed 13/13 after these assertion changes. For the
required expiry mutation, removing only the installed expiry predicate and binding caused the
reference suite's expired POST hash assertion to fail (12 passed, 1 failed, 15 seconds). Reinstalling
the complete verified vendor archive restored its original member bytes; the lockfile checksum
refresh was local validation state and the tracked lockfile was restored. In the fresh retained
scaffold the same mutation caused the corresponding hash assertion to fail (3 passed, 1 failed,
4 seconds); restoring the exact archive member returned the four tests to green. Neither archive
was modified. SQLite, Chromium and local callback capture remain the evidence limits.
