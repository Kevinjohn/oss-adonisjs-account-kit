# Add password reset to an existing Inertia Vue application

Use this recipe when an AdonisJS 7 application already has a Vue/Inertia login form, user model,
session guard and protected pages. Keep those application-owned pieces and add reset routes and pages
around them. Start with the [shared reset integration checklist](../guides/password-reset-existing-app.md)
and follow the [root install instructions](../../README.md#install) for the available archive and
configuration command.

The pinned official Vue starter and its pre-install login check are recorded in the
[starter baselines](../maintainers/verification.md#starter-baselines). A copied reference example is
not a clean existing-application integration. Keep your own email normalization, password policy,
authorization rules, language, page layouts and styling.

## Keep the original login and protect existing sessions

Configure only the reset capability and the application's session guard in `config/account_kit.ts`:

```ts
enabled: ['passwordReset'],
registration: { availability: 'open' }, // required by config even when registration is disabled
authentication: {
  strategy: 'session',
  guard: 'web',
  canAccess: async (user, trx) => true, // replace with the application's account policy
},
```

Use the application's real account restriction in `canAccess`. Keep the existing `/login` GET and
POST routes, `User` model and `web` guard. Adapt the existing login controller's POST action to call
`kit.authentication.login` with the existing email/password validator and a session guard adapter;
do not add a second login route. The adapter logs in through `web`, regenerates the session, and
stores the returned credential revision as `accountKitRevision`. Logout continues through the same
guard and clears that revision.

Add a revision-check middleware after silent authentication in `start/kernel.ts` and before named
`auth` middleware runs. On each authenticated request, pass the current user's ID and stored
revision to `kit.authentication.current`; terminate the session when it throws `InvalidSessionError`.
Treat an absent revision as invalid and the empty string as a session created before the first
credential change. This makes reset revocation visible on the next request to the application's
existing protected routes. Add other session, API-key or remember-me revocation to the application's
credential-change transaction if those credentials exist.

The starter defaults to its encrypted cookie store and does not include a sessions-table migration.
Use its existing `database` session store, add an application-owned `sessions` table migration (the
committed patch provides one), and run migrations before serving the app. A copied cookie must not
keep a reset session alive. Keep Shield's CSRF middleware enabled for the state-changing reset POST.

## Add the reset flow around the existing pages

Keep the existing Inertia Vue `<script setup>` conventions, layouts and field components. Add a
guest forgot-password page and a reset page, normally at `/forgot-password` and
`/reset-password/:token`. The request page posts the email to a controller which validates it,
passes `request.ip()` as the rate-limit key, and always flashes the same acknowledgement for known
and unknown addresses. The controller catches only known post-commit delivery failures, logs a
generic event, and does not disclose whether an address exists.

The controller's reset-link GET calls `passwordReset.inspect` without consuming the proof or ending
the current browser's session. Set a restrictive `Referrer-Policy` before rendering the page so
the token is not sent to an unrelated origin. Render an unusable-link state for malformed, expired
or consumed proofs, with links to request a new one and sign in. The reset POST validates the new
password and confirmation with the application's existing password policy, calls
`passwordReset.reset`, handles invalid proofs without changing credentials, then terminates the
current session and redirects to the existing login route.

Use Inertia Vue's `Form` with the existing named routes, `params` for the token, Shield's CSRF
protection, and the app's current error-summary and field-error components. Keep validation and
recovery copy in the application. The reference form clears both password inputs on an error or
success; it does not retain secrets in Inertia state. See
[`account_form_errors.spec.ts`](../../examples/inertia-vue/tests/browser/account_form_errors.spec.ts)
for the mismatch behavior. Use `autocomplete="email"`/`username` and `autocomplete="new-password"`,
keep labels associated with controls, announce errors and focus the error summary.

Review every generated migration before applying it. Selecting only `passwordReset` does not make
the generated schema reset-only; see the shared checklist for all tables and columns. Keep
application-owned user and session migrations and account policy separate from package migrations.

## File and test map

Adapt only the files needed for your application:

| Responsibility                                             | Vue example reference                                                                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep login route and integrate revision-aware login/logout | `app/controllers/session_controller.ts`, `app/services/session_guard.ts`, `app/middleware/session_revision_middleware.ts`, `start/routes.ts`, `start/kernel.ts` |
| Validate reset request and replacement password            | `app/validators/account.ts`                                                                                                                                     |
| Request, inspect and complete proofs                       | `app/controllers/password_resets_controller.ts`                                                                                                                 |
| Request and reset forms with field errors                  | `inertia/pages/auth/forgot_password.vue`, `inertia/pages/auth/reset_password.vue`                                                                               |
| Focus and link validation feedback                         | `inertia/components/form_error_summary.vue`, `inertia/components/form_error_summary.ts`                                                                         |
| Reset URL and notification callback                        | `config/account_kit.ts`                                                                                                                                         |
| Use a server-side session store                            | `.env.example`, `config/session.ts`, app-owned `sessions` migration                                                                                             |

The committed [recipe patch](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/adoption/vue-reset-recipe/docs/recipes/patches/inertia-vue-password-reset.patch)
is the application-owned change set used by the clean-starter check. The accompanying browser spec is
[`inertia-vue-password-reset.spec.ts`](../../examples/inertia-vue/tests/recipes/inertia-vue-password-reset.spec.ts).

| Failure or invariant                                                                                          | Browser evidence                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed proof leaves the current password and both sessions unchanged                                       | `account_journeys.spec.ts`: “a signed-in reset ends old sessions and rejects proof replay”; recipe spec: “the original login and two browser sessions obey the complete reset lifecycle” |
| Expired proof leaves the current password and both sessions unchanged                                         | Both named journeys insert a proof with a past `expires_at`                                                                                                                              |
| A replaced proof cannot reset the password                                                                    | Recipe spec posts the replaced proof; `account_journeys.spec.ts` also checks the old link's unusable state                                                                               |
| A confirmation mismatch clears secret fields and leaves credentials unchanged                                 | `account_form_errors.spec.ts`: “reset clears password fields after error and associates the confirmation message”; recipe spec submits a mismatch                                        |
| A consumed proof cannot change the replacement credential again                                               | The recipe spec replays the consumed proof through the reset POST; `account_journeys.spec.ts` checks the unusable-link page                                                              |
| Both old sessions fail on the protected dashboard; old password fails and new password works through `/login` | Both named journeys use two independent browser contexts and the original login route                                                                                                    |

## Run the example

From `examples/inertia-vue`, use the repository's Node 24 and pnpm workflow:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Browser tests use SQLite and local callback capture. They prove application behavior and proof URL
generation, not inbox delivery or PostgreSQL behavior.

## Clean application check

The native `/login` form passed before Account Kit installation: its original credentials opened the
protected `/dashboard`, which also returned successfully on a second direct request. In the fresh P6
scaffold, `pnpm test --files=recipe_starter_login.spec.ts` passed 1/1 (444 ms). The pinned official
starter revision is `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`. Its P1 scaffold command was:

```sh
pnpm create adonisjs@3.4.0 <dir> --kit=github:adonisjs/starter-kits/inertia-vue#46d235932e3eb6472a16b740fa0b47b5f69fc6fc --pkg=pnpm
```

The generated starter manifest used these relevant ranges: `@adonisjs/auth` `^10.1.0`,
`@adonisjs/core` `^7.5.2`, `@adonisjs/inertia` `^5.0.1`, `@adonisjs/lucid` `^22.4.2`,
`@adonisjs/session` `^8.1.0`, `@adonisjs/shield` `^9.0.0`, `@inertiajs/core` and `@inertiajs/vue3`
`^3.7.1`, `vue` `^3.5.43`, `@japa/browser-client` `^2.3.0`, and `@japa/runner` `^5.3.0`. See the
[pinned official Vue starter manifest](https://github.com/adonisjs/starter-kits/blob/46d235932e3eb6472a16b740fa0b47b5f69fc6fc/inertia-vue/package.json)
for the complete generated dependency ranges. Its pre-install lockfile SHA-256 was
`1361cab418a9cd17746e6b0deb372505a013575d6adf8fb5eb6c851366939fc3`; the clean starter commit was
`ae2ee4c73b8b668161435e8d74d853707bdc3a7f` after manual Git initialization because the creator does
not initialize a repository. Account Kit was configured at checkpoint
`40e070424d6bda22579a4ea8f8b242c3b770db40` before applying the committed patch. See the verification
record for the original P1 baseline and source comparison.

The fresh P6 recipe run passed 1/1 in 4 seconds at source revision
`db679e07e31ea2fe26e91d0d977ea4a3b3600744`. It kept the original starter login and checked malformed,
expired, replaced and consumed reset proofs with CSRF-protected POSTs, unchanged password hashes and
two existing sessions; it also checked mismatch-field clearing, both old sessions' protected-route
rejection, old-password login failure and new-password login success. The retained evidence is
`/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-XI5BdN/evidence.json`.

The check used Node 24.21.0, pnpm 11.23.0, AdonisJS Core 7.6.0 and SQLite 3.53.4. It installed the
unchanged development candidate archive built from source revision
`402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf`, SHA-256
`fd01e7fcb561f04934c5abb58701271515e9f55afeca1a8465aa913896669227`. This candidate is a local
development pack, not a published release; the [root install instructions](../../README.md#install)
describe installing released archives. The exact recipe command was:

```sh
pnpm test:recipe -- --recipe=inertia-vue-password-reset --candidate-tarball=/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-RukBcO/candidate/adonisjs-account-kit-0.1.1.tgz --candidate-revision=402d5e91f94c4a4acfd8ad45da546fbb4a10d0cf
```

The full Vue application suite (unit, functional and browser) passed 35/35 in 13 seconds, including the composed reset journey. For P7,
an installed-vendor-only mutation that preserved the old credential revision made the prior recipe
spec fail in 3 seconds: the existing session still reached `/dashboard` instead of redirecting to
`/login`. That negative run preceded the malformed and expired POST assertions added to the final
spec. The original archive member was restored byte-for-byte; the final spec passed 1/1 in 4 seconds
when rerun with the harness-printed command and retained test environment:

```sh
"/Users/kevinjohngallagher/.nvm/versions/node/v24.21.0/bin/node" "/var/folders/hx/yyy7zv5n1wx8rsxpbc52cr4r0000gn/T/account-kit-recipe-gpaGD9/rerun.mjs"
```

Notifications were captured by an in-process callback; this verifies link generation, not delivery
to an inbox. These checks use SQLite and do not establish PostgreSQL behavior.
