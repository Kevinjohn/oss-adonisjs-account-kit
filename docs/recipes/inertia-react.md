# Add password reset to an existing Inertia React login

Keep the official AdonisJS 7 React starter's `/login`, `User` model, `web` guard, `/dashboard`
and styling. Add only password reset. “Keep your login” includes adapting its controller to
capture a credential revision; an unchanged session login cannot revoke older sessions.

First complete the mandatory [existing-application checklist](../guides/password-reset-existing-app.md),
including the [README installation instructions](../../README.md#install), required peers,
Limiter setup and every generated migration. The setup schema is shared across capabilities;
`enabled: ['passwordReset']` does not generate a reset-only schema. See the
[session integration](sessions.md) for the guard contract.

The [hand-edit patch](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/fd457fdce9dcca378b0bb7caee402226896c9700/docs/recipes/patches/inertia-react-password-reset.patch) applies after configure to the
[pinned starter](../maintainers/verification.md#starter-baselines). It supplies
application controllers, validators, pages and session wiring; it contains no generated migration,
generated schema, dependency entry, lockfile or archive. Its handwritten `sessions` migration
belongs to the application and is separate from Account Kit's generated session registry.

## Preserve the native login and enforce revocation

Keep `app/controllers/session_controller.ts` and its routes. Its `store` still validates the
starter's email/password form and redirects to the existing dashboard, then delegates credential
establishment to `kit.authentication.login` with the existing `web` guard. The adapter in
`app/services/session_guard.ts` regenerates the session, calls `web.login`, and stores the returned
revision in `accountKitRevision`. It clears and regenerates the session on termination. The
starter signup controller keeps its validation and `User.create`, then uses the same credential
adapter for its automatic login, so the new revision check does not break signup.

Enable only `passwordReset` and select `authentication: { strategy: 'session', guard: 'web',
canAccess: async () => true }` in `config/account_kit.ts`; replace the permissive callback with
the application's real restriction policy. The no-op credential callback is deliberate only
because this application has no additional credentials. Revoke additional API keys or remember-me
credentials transactionally if the application uses them.

**Mandatory:** set `SESSION_DRIVER=database`, apply the handwritten `sessions` migration, and run
all generated migrations. The patch refuses the cookie store. A shared server-side store is
required in production; this recipe exercises SQLite-backed sessions locally. Existing sessions
without `accountKitRevision` must sign in again.

The router middleware order is body parser, session, Shield, Auth initialization, native silent
authentication, then `session_revision_middleware`. The revision middleware calls
`kit.authentication.current` for the authenticated user, passes the saved revision (including an
explicit null before the first change), and terminates missing/stale sessions. The native auth
middleware subsequently redirects protected requests to `/login`. Put proof-response headers in
the early server stack so proof failures also receive `Cache-Control: no-store` and
`Referrer-Policy: same-origin`. Exclude proof URLs from access logs, analytics and error reports.

## Controllers, pages and forms

The patch adds these application-owned routes without moving the starter routes:

| Method     | Path                     | Purpose                                                           |
| ---------- | ------------------------ | ----------------------------------------------------------------- |
| GET / POST | `/forgot-password`       | Guest form and generic request acknowledgement                    |
| GET        | `/reset-password/:token` | Inspect without consumption and render valid/invalid proof page   |
| POST       | `/reset-password/:token` | Validate confirmation, consume proof and redirect to native login |

The forgot form is guest-only; reset inspection and completion remain public, including for a
signed-in browser. The controller never uses submitted user IDs as authority. It catches committed
delivery failures without claiming recipient delivery and keeps known/unknown request feedback
identical. Invalid proof submissions return useful application flash feedback and the invalid
page offers a fresh-link action. Throttling gets retry guidance through the exception handler.

`urls.passwordReset` points to the application-owned `/reset-password/:token` page. The sample
configuration uses development log notifications, which refuse production; connect real delivery
before deploying. The acceptance spec replaces those callbacks with local capture.

`inertia/pages/auth/forgot_password.tsx` and `reset_password.tsx` reuse `AuthLayout`, the native
`auth__*`, `field__*` and `btn` classes, and the starter's typed Inertia `Form`/`Link` components.
The login page gains one forgot-password link. The starter Inertia middleware already shares
validation errors and flash messages, so its existing toast and theme remain in place.

After adding the routes and pages, run `pnpm exec node ace codegen` before `pnpm build`.
The build indexes controllers and pages, while the explicit codegen command also regenerates
the typed client route registry used by Inertia forms. A stale registry cannot resolve the new
reset form's route even when the backend route listing is correct.

Shield stays enabled. Forms use the native Inertia/Shield CSRF integration; direct failure POSTs
in the acceptance spec also send the real browser's CSRF token. New passwords use the starter's
8–32-character validation, with confirmation matched server-side. Inspection never consumes the
proof or changes the browser identity. On successful reset, the current signed-in browser is
terminated and redirected to login; other sessions fail on their next protected request.

The proof-page controller keeps inspection separate from completion:

```ts
import type { HttpContext } from '@adonisjs/core/http'
import kit from 'adonisjs-account-kit/services/main'

async function edit({ inertia, params, response }: HttpContext) {
  response.header('Cache-Control', 'no-store')
  response.header('Referrer-Policy', 'same-origin')
  const valid = await kit.passwordReset.inspect({ token: params.token })
  return inertia.render('auth/reset_password', { token: params.token, valid })
}
```

### Failed-submission password policy

Keep both password fields in the mounted reset form after a confirmation error, so the user can
correct the confirmation without retyping the new password. Do not store either value in session,
flash, logs, a URL or application persistence. A page navigation/reload creates empty inputs.
The patch's reset-path HTML validation handler flashes errors without request input. This also
protects ordinary HTML submissions without an `X-Inertia` header; camel-case confirmation fields
must not fall through to the session middleware's default input flashing.
The error summary receives focus, links to the invalid field, and connects field feedback using
`aria-invalid` and `aria-describedby`. The reference app's
[form-error spec](../../examples/inertia-react/tests/browser/account_form_errors.spec.ts) checks
retention of both values and keyboard-accessible recovery.

## Failure and credential matrix

Every row is exercised by `React reset recipe preserves failed submissions and revokes both native
sessions` in the [committed acceptance spec](../../examples/inertia-react/tests/recipes/inertia-react-password-reset.spec.ts).
The spec signs two distinct native sessions in before reset and verifies each reaches the native
protected dashboard. “Unchanged” means byte-identical stored hash and successful protected
requests from both saved sessions, rather than a reset response or database token count.

| Case                    | Expected behavior and assertions                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Known / unknown request | Same visible generic acknowledgement; only known account emits captured proof                                              |
| Valid proof GET twice   | Both pages allow a new password; proof still completes later                                                               |
| Confirmation mismatch   | Field error; both entered values retained; hash and both sessions unchanged                                                |
| Native HTML mismatch    | Validation errors recorded without either password in database sessions; reload clears inputs; hash and sessions unchanged |
| Malformed proof         | Invalid page and rejected POST; hash and both sessions unchanged                                                           |
| Expired proof           | Insert a past-expiry proof row; invalid page and rejected POST; hash and both sessions unchanged                           |
| Replacement link        | Inspect a fresh live proof, request replacement, reject prior proof; unchanged hash/sessions; replacement completes        |
| Consumed proof          | Invalid page and rejected replay; new hash and two fresh successful sessions unchanged                                     |
| Successful reset        | Both old sessions redirected to native login; old-password login fails; new-password login reaches dashboard               |

The reference app's [composed browser journey](../../examples/inertia-react/tests/browser/account_journeys.spec.ts)
also signs in two clients before reset, checks native redirects for each old session, and tries the
old and new passwords through `/login`.

## Clean application check

**22 October 2026 — fresh P6 and P7 passed.** The harness scaffolded the pinned official React
starter, proved native login with its original cookie store, installed the supplied archive,
configured dependencies, applied the hand edits, migrated to the application-owned database
session store, generated the client route registry, built the app, and ran the browser spec.

| Field                                    | Recorded evidence                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fresh harness source                     | `3a2831b6713473e3894147c0e29bd1fb614502dc` (clean working tree)                                                                                              |
| Final assertion-order source             | `23564cf82539a37a981e2766bafce8fff83aae9f`; checked by the retained P7 replay                                                                                |
| Package archive source                   | `402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf`                                                                                                                   |
| Archive SHA-256                          | `fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`                                                                                           |
| Creator / starter                        | `create-adonisjs` `3.4.0`; official `inertia-react` starter `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`                                                       |
| Starter baseline / configured checkpoint | `1c59e0e4ad54c9909555879312767420915de632` / `dff9f1e85c6872ad911b6a52e4ba44645214b97e`                                                                      |
| Starter lockfile SHA-256                 | `2cfe6653de580f91d8900002bff44da5cc40a15c42691560a5ba22921a6232fd`                                                                                           |
| Runtime / package manager                | Node `24.21.0`; pnpm `11.23.0`                                                                                                                               |
| Installed framework                      | Core `7.6.0`; Inertia `5.0.4`; Session `8.3.0`; Shield `9.0.0`; React `19.3.1`; Inertia React `3.9.1`; Japa browser client `2.3.0`                           |
| Database / sessions                      | SQLite `3.53.4` in the retained application's `tmp/db.sqlite3`; native cookie store for the untouched baseline, database store after applying the recipe     |
| Notification mode                        | Local in-process callback capture; no recipient delivery                                                                                                     |
| Fresh P6                                 | Acceptance browser spec: 1/1 passed, 6 seconds total                                                                                                         |
| P7 mutation                              | Omitted revision advancement in the installed package; explicit assertion failed, expected `/login`, received `/dashboard`, 5 seconds                        |
| P7 restoration                           | Copied exact implementation bytes from the same archive; identical replay command passed 1/1 in 5 seconds                                                    |
| Reference app                            | Full `pnpm test`: 33/33 passed in 14 seconds, including the changed journey and both-field retention checks                                                  |
| Scoped checks                            | Actual application build, typecheck and lint passed; reference typecheck and lint passed; four documentation suites passed 13/13; documentation build passed |

The [acceptance spec](../../examples/inertia-react/tests/recipes/inertia-react-password-reset.spec.ts)
ran `React reset recipe preserves failed submissions and revokes both native sessions`. The final
assertion-order change reports an unexpected native redirect immediately after the protected
navigation; it preserves the credential requirement. The same final spec failed under mutation
and passed after restoration. The archive digest remained unchanged.

From the repository root, the fresh run used:

```sh
pnpm test:recipe -- --recipe=inertia-react-password-reset \
  --candidate-tarball=<archive-path> \
  --candidate-revision=402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf
```

The harness created the application with:

```sh
pnpm create adonisjs@3.4.0 <directory> \
  --kit=github:adonisjs/starter-kits/inertia-react#46d235932e3eb6472a16b740fa0b47b5f69fc6fc \
  --pkg=pnpm
```

It recorded the baseline with `git init`, `git add -A` and `git commit -m starter`. Its evidence
JSON retains the generated manifest, lock digest, generated-file inventory, command outputs,
configured checkpoint and exact retained replay command. The generated manifest requested Core
`^7.5.2`, Auth `^10.1.0`, Inertia `^5.0.1`, Lucid `^22.4.2`, React `^19.3.0` and Inertia React
`^3.7.1`; the lock digest above identifies the resolved dependency set.

The copied acceptance file ran in the fresh application's browser suite through `pnpm test` with
that file selected. Node 24 was enforced for the script and its children. The retained private
settings use `NODE_ENV=test`, UTC, a loopback host with an allocated port and matching `APP_URL`,
a generated development `APP_KEY`, `SESSION_DRIVER=database` and `LIMITER_STORE=memory`. Run the
printed Node executable and `rerun.mjs` command to reproduce these settings; a bare test command
with a different environment does not reproduce the record.

For P7, the installed package's `advanceCredentialRevision` implementation had only its
`credentials_changed_at` update removed. An original session then survived its native
protected request, and the explicit redirect assertion detected the failure. Restoration read
the exact JavaScript member from the supplied archive, without rebuilding or repacking; the same
replay command returned to green. Session cleanup and all other application policy stayed intact.

The reference app ran `pnpm test` from `examples/inertia-react` using the same archive. Its
[composed journey](../../examples/inertia-react/tests/browser/account_journeys.spec.ts) and
[form-error checks](../../examples/inertia-react/tests/browser/account_form_errors.spec.ts) verify
the existing application's routes and retention policy independently of the fresh recipe app.

Limits: local SQLite, Chromium and local notification capture. No recipient delivery,
PostgreSQL, other browser engine, manual viewport or keyboard sign-off is claimed. See the
[evidence format](../guides/example-acceptance.md#updating-the-record).

### Native HTML validation correction — 23 October 2026

A CSRF-valid HTML reset submission without `X-Inertia` previously let the default session
validation handler flash the camel-case `passwordConfirmation` value. The committed recipe patch
now disables input flashing for reset validation errors while preserving the mounted Inertia
form's retention policy. The acceptance spec verifies signed database-session values, observes
the validation error, checks that neither submitted password is stored, reloads empty inputs,
and proves the password hash and both native sessions are unchanged.

| Field                 | Recorded evidence                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correction source     | `fd457fdce9dcca378b0bb7caee402226896c9700`                                                                                                                                                                     |
| Archive               | `adonisjs-account-kit-0.1.1.tgz`; SHA-256 `fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`                                                                                                   |
| P1 starter            | Creator `3.4.0`; starter `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`; baseline `109c325c46efbd8fa6e3c085a59c78d197ed7b54`; configured checkpoint `7ced0b0d47fa9789bc6f5870f9067626b173432a`                     |
| Lockfile SHA-256      | `2cfe6653de580f91d8900002bff44da5cc40a15c42691560a5ba22921a6232fd`                                                                                                                                             |
| Runtime and database  | Node `24.21.0`, pnpm `11.23.0`, Core `7.6.0`, SQLite `3.53.4`; original cookie sessions before installation, database sessions afterward                                                                       |
| P6                    | `pnpm test:recipe -- --recipe=inertia-react-password-reset` passed on a fresh pinned starter, including original login before installation, application build, route listing and the updated recipe spec       |
| Validation regression | Removing the reset validation override failed on the submitted confirmation appearing in verified session data; restoring it passed the same retained spec 1/1 in 6 seconds                                    |
| P7                    | Removing only credential-revision advancement failed at the old-session assertion: expected `/login`, received `/dashboard`; restoring implementation bytes from the unchanged archive passed 1/1 in 6 seconds |

The P1 command remains the pinned React scaffold command above. The P6 evidence retains its
generated manifest, installed versions, native-login output, generated inventory and exact replay
environment. Both mutation checks used the printed retained replay command, which runs
`pnpm test --files=inertia-react-password-reset.spec.ts` inside the scaffold. The archive digest
remained unchanged through restoration. Notification capture is local; this correction adds no
recipient-delivery, PostgreSQL, other-browser, viewport or keyboard claim.
