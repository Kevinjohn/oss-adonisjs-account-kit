# Account API example

A complete AdonisJS 7 API app that uses Account Kit from its own controllers. Copy from it when
you wire Account Kit into your app; the [usage guide](../../docs/usage.md) points here for the
full picture.

For a single supported API-starter journey with one namespace and the opaque `api` guard, begin
with [Build one account API](../../docs/guides/core-api.md). This example also has optional
admission, invitation, and social integrations. Its notification capture and sample outbox are
demo/test fixtures; the copy row below states their limits.

## What to copy

| You want                                                                               | Look at                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The config                                                                             | [`config/account_kit.ts`](config/account_kit.ts)                                                                                                                                                                                                                                                             |
| Routes and middleware placement                                                        | [`start/routes.ts`](start/routes.ts), [`start/kernel.ts`](start/kernel.ts)                                                                                                                                                                                                                                   |
| Controllers for each flow                                                              | [`app/controllers/`](app/controllers)                                                                                                                                                                                                                                                                        |
| Request validation                                                                     | [`app/validators/`](app/validators)                                                                                                                                                                                                                                                                          |
| Mapping errors to HTTP responses                                                       | [`app/exceptions/handler.ts`](app/exceptions/handler.ts)                                                                                                                                                                                                                                                     |
| Session and token guard adapters                                                       | [`app/services/account_kit_guards.ts`](app/services/account_kit_guards.ts)                                                                                                                                                                                                                                   |
| **Demo/test only — do not copy for production:** captured mail, dispatcher, and outbox | [`app/services/account_kit_notifications.ts`](app/services/account_kit_notifications.ts), [`app/services/account_kit_outbox.ts`](app/services/account_kit_outbox.ts), [`database/migrations/1800000000001_create_notifications_outbox.ts`](database/migrations/1800000000001_create_notifications_outbox.ts) |
| Signing out old credentials                                                            | [`app/middleware/account_access_middleware.ts`](app/middleware/account_access_middleware.ts)                                                                                                                                                                                                                 |
| HTTP tests                                                                             | The exact per-flow suites are listed below.                                                                                                                                                                                                                                                                  |

These deterministic fixtures keep receiver idempotency in memory, stop at the first failed row,
and have no backoff or safe concurrent claims. Use [notification guidance](../../docs/notifications.md)
for production mail and workers.

## Run it

The source package manifest is `0.0.0`; there is no matching public npm release and repository tag
for a consumer install yet. The published-package path is blocked on that release. This contributor
path builds an archive from the current repository and does not establish a released-package
install.

Use Node.js 24 and pnpm 11.23.0. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --out examples/api/vendor/adonisjs-account-kit.tgz
cd examples/api
pnpm install
cp .env.example .env
node ace generate:key
node ace codegen
node ace migration:run
pnpm dev
```

The API listens at <http://localhost:3333>; `GET /` returns `{"hello":"world"}`. The `.env.example`
uses SQLite, and `node ace generate:key` fills the local `APP_KEY`. Its OAuth values are inert
placeholders so the core flow can boot without provider accounts; replace them before using social
sign-in. To exercise the routes, run
`pnpm test` here or use the repository's `pnpm test:consumer` from the root; those suites verify the
signup, email verification, login, and account API flows over HTTP.

In development, the example prints proof links to the server log and keeps its in-memory capture
for tests. This makes the HTTP journey inspectable locally; it does not send email or prove
recipient delivery. The production path deliberately does not print proof links. Use a configured
transport in an application.

For a short HTTP smoke, submit a signup with `fullName`, `email`, `password`, and
`passwordConfirmation` to `POST /api/v1/auth/signup`. Copy the verification URL from the server log
and POST it with the chosen password and confirmation. Then POST the credentials to
`/api/v1/auth/login` and use the returned bearer token for `GET /api/v1/account/profile`. The
[core API walkthrough](../../docs/guides/core-api.md) explains the same guard and proof boundaries.

The archive is ignored under `examples/api/vendor/`. The root install supplies the package build
tools. Build and pack from the repository root before installing the example because its local
package dependency points at that archive. Once the example is installed, `pnpm kit:pack` refreshes
the archive after source changes. Run `pnpm install` again in the example after each re-pack to
install the new archive and update its integrity entry; this refresh install cannot use
`--frozen-lockfile`. Keep the generated archive out of Git.

## Copy maps

The source directory is `examples/api/`; each source path below maps to the same destination path
in your app. The core path uses the starter's opaque `api` guard and one `/api/v1` namespace, as
in [Build one account API](../../docs/guides/core-api.md). Each flow needs the shared foundation
and its listed files. Merge route and kernel entries instead of replacing starter files, and keep
`User.accessTokens` with `auth_access_tokens`. Install package migrations with the configure
command; do not copy the example's package migrations. The core path does not need the optional
session, social, invitation, admission, or outbox integrations.

### Shared API foundation

- `examples/api/config/account_kit.ts` → `config/account_kit.ts`: adapt the selected capabilities,
  Lucid user mapping, `api` access-token config, URLs, and callbacks. Registration fields,
  authorization, and callback behavior are application policy. The config imports
  `examples/api/app/services/registration_fields.ts` for registration mapping; copy it or replace
  that helper with your mapping. It also imports application authorization callbacks, the sample
  notification receiver, and social/admission integrations. Remove unused social/admission/test
  imports, implement callbacks for enabled features (the reference policy is in
  `examples/api/app/services/account_kit_authorization.ts`), and replace sample notifications with
  your application-owned transport as described in
  [notification guidance](../../docs/notifications.md).
- `examples/api/app/services/account_kit_guards.ts` → `app/services/account_kit_guards.ts`: keep
  the `accessTokenGuard` adapter and adapt the User import. Omit its session adapter for this path.
- `examples/api/app/services/auth_strategy.ts` → `app/services/auth_strategy.ts`, and
  `examples/api/app/middleware/auth_middleware.ts` → `app/middleware/auth_middleware.ts`: keep the
  `access_tokens` selection so auth middleware and silent auth resolve `api`; omit the session
  branch from copied routes. The named `auth()` middleware authenticates before protected handlers.
  For this API-only path, adapt `app/services/account_input.ts` to keep the selected `api` guard and
  return its user/token identifiers, but remove its `ctx.session.get('accountKitRevision')` read
  and session branch: it reads the session before checking the strategy. Remove the session adapter
  and session-only password-change branch as well.
- `examples/api/app/exceptions/handler.ts` → `app/exceptions/handler.ts`: merge
  `accountErrorResponse` while preserving the starter's unknown-error handling.
- `examples/api/start/kernel.ts` and `examples/api/start/routes.ts` → the same paths: merge only
  body parsing, Auth initialization, JSON response handling, proof-response headers, request
  bindings, CORS, named middleware, and selected `/api/v1` route entries. Keep
  `app/middleware/proof_response_headers_middleware.ts`,
  `app/middleware/force_json_response_middleware.ts`, and
  `app/middleware/container_bindings_middleware.ts`; the first two use
  `app/services/http_responses.ts` and `app/services/accept_negotiation.ts`. Drop session, Shield,
  social-header, and unused silent-auth middleware for the API-only path. The global kernel runs
  before handlers; public proof routes do not use `auth()`.

### Signup, email verification, and login

Required additions: `examples/api/app/controllers/new_account_controller.ts`,
`email_verifications_controller.ts`, and `access_tokens_controller.ts` → the same paths;
`examples/api/app/validators/user.ts`, `account_kit.ts`, `fields.ts`, and `password.ts` →
their matching paths; also copy `app/transformers/user_transformer.ts` and
`app/services/committed_failure_diagnostic.ts`. The controllers import the starter's `User` model,
which remains in the starter. To make this fixture API-only, remove the session branch and
`authStrategy` and `accountKitSessionGuard` imports from `new_account_controller.ts`; remove the
strategy branch from `account_password_controller.ts`. Keep `app/services/last_used_method.ts` for
the signed preference cookie, or remove its `rememberLastUsedMethod` calls from signup and login.
Signup, login, and proof
GET/POST verification routes are public under `/api/v1/auth`; the resend route
`POST /api/v1/account/email-verification/send` is protected by `auth()` then `accountAccess()`.
Copy `app/middleware/account_access_middleware.ts` and `app/services/account_input.ts` for that
route, applying the API-only adaptation above. `email_verifications_controller.ts` uses
`app/services/http_responses.ts` and `accept_negotiation.ts` for proof headers/errors. Adapt
registration field mapping, availability, validators, and response language. Verify with
[`account_signup_login.spec.ts`](tests/functional/account_signup_login.spec.ts) and
[`account_email_verification.spec.ts`](tests/functional/account_email_verification.spec.ts).

### Password reset

Required additions: `examples/api/app/controllers/password_resets_controller.ts` and
`examples/api/app/validators/account_kit.ts` → the same paths; its import closure also needs
`app/validators/fields.ts` and `app/validators/password.ts`. Copy
`app/services/http_responses.ts`, `app/services/accept_negotiation.ts`, and
`app/services/committed_failure_diagnostic.ts`; merge the reset routes from
`examples/api/start/routes.ts`. The request, inspect, and completion handlers are public routes
without account auth. Body parsing runs before each handler; the global
`proof_response_headers_middleware` adds privacy headers to inspect and completion token paths.
Keep the generic request acknowledgement and adapt validators to your policy. Verify with
[`account_password_reset.spec.ts`](tests/functional/account_password_reset.spec.ts).

### Protected profile and password change

Required additions: `examples/api/app/controllers/profile_controller.ts` and
`account_password_controller.ts` → the same paths; `examples/api/app/services/account_input.ts` →
the same path; adapt it for the API-only guard by removing the session read and branch noted above.
Retain `app/services/auth_strategy.ts` with its fixed `access_tokens` selection for the shared auth
middleware, silent-auth middleware, and `account_input`; remove the session-only branch in
`account_password_controller.ts`. Copy `app/middleware/account_access_middleware.ts`,
`verified_account_middleware.ts`, and `app/services/committed_failure_diagnostic.ts`; the account
route group's `auth()` runs first, then profile uses `accountAccess()` while password change uses
`verifiedAccount()`. Both middleware files depend on `account_input.ts`. Both controllers import
`app/validators/account_kit.ts`; its closure includes `app/validators/fields.ts` and
`app/validators/password.ts`. Adapt the profile allowlist and password rules. Verify with
[`account_profile_email.spec.ts`](tests/functional/account_profile_email.spec.ts) and
[`account_password_change.spec.ts`](tests/functional/account_password_change.spec.ts).

### Admission (optional add-on)

Copy only when the application gates its own data on admission:
first follow [admission setup](../../docs/admission.md) and install its provider, command loader,
config, and migration (for example, `node ace account-kit:admission:install` followed by the
documented migration step). Register `adonisjs-account-kit/admission/provider` in `adonisrc.ts`.
Copy/adapt `examples/api/config/admission.ts`; merge `admissionAuthorize` into the approval
callbacks in `config/admission.ts`. In `config/account_kit.ts`, install
`withAdmissionCleanup()` on `onAccountDeletingTransaction`; if invitation evidence is required,
wrap `onInvitationAccepted` with `withInvitationEvidence()` around the application's role grant.
`ACCOUNT_KIT_ADMISSION_DOMAINS` is optional and only supplies allowed domains when the domain
requirement is enabled. Add `app/controllers/admissions_controller.ts`,
`app/middleware/admitted_account_middleware.ts`, `app/services/account_kit_authorization.ts`, and
`app/validators/admission.ts` at the same destination paths; merge the admission routes from
`examples/api/start/routes.ts` and the `admittedAccount` registration from `start/kernel.ts`.
The example's `database/migrations/1791906000000_create_role_assignments.ts` is application-owned
role storage; the admission migration is package-generated by the install command, not an example
file to copy. The account group's `auth()` runs first. Status and request routes remain available
to authenticated people before admission; list and decision routes add `admittedAccount()` and the
matching authorization callback. Owner/role definitions, callbacks, validators, and the local
role-assignment table are application policy. Verify with
[`admission.spec.ts`](tests/functional/admission.spec.ts); add the invitation suite if your policy
grants admission from invitation evidence.

## Admission routes

All routes below use the `/api/v1` prefix. The `account` route group applies `auth()` to every
route, so callers need a valid selected-guard credential. Status and request routes deliberately
have no `admittedAccount()` gate; they remain available to signed-in people who are pending,
rejected, or revoked.

| Route                                                                  | Controller and request                                                                                                                                                                                                                                        | Route gate and application policy                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/account/admission`                                        | [`AdmissionsController.show`](app/controllers/admissions_controller.ts) returns the current decision.                                                                                                                                                         | `auth()` only; available before admission.                                                                    |
| `POST /api/v1/account/admission/request`                               | [`AdmissionsController.request`](app/controllers/admissions_controller.ts) records an idempotent request; no request body.                                                                                                                                    | `auth()` only; available before admission. The service refuses an unconfirmed account.                        |
| `GET /api/v1/account/admissions?status=&cursor=&limit=`                | [`AdmissionsController.index`](app/controllers/admissions_controller.ts) validates the query with [`admissionListValidator`](app/validators/admission.ts). `status` is `pending`, `approved`, `rejected`, or `revoked`; `limit` is 1–100; `cursor` is opaque. | `auth()` then `admittedAccount()`, followed by `admissionAuthorize.list`; the example policy allows owners.   |
| `POST /api/v1/account/admissions/:id/approve`, `/reject`, or `/revoke` | [`AdmissionsController.approve`, `.reject`, and `.revoke`](app/controllers/admissions_controller.ts) take the subject ID from the path and no request body.                                                                                                   | `auth()` then `admittedAccount()`, followed by `admissionAuthorize.decide`; the example policy allows owners. |

The route gates are placed in [`start/routes.ts`](start/routes.ts). The selected guard is
authenticated by the account group; among these admission routes, `admittedAccount()` is attached
only to the list and decision routes. The service also checks its `list` or `decide` callback, configured in
[`config/admission.ts`](config/admission.ts). The example's owner check lives in
[`account_kit_authorization.ts`](app/services/account_kit_authorization.ts); your application owns
what an owner is and who may grant roles or approve accounts. Account Kit does not define tenant
roles or grant invitation roles itself.

The example's explicit invitation-link path is `POST /api/v1/auth/invitations/:token`; its
password and signup fields are described in the [invitation controller](app/controllers/invitations_controller.ts)
and [`invitationAcceptValidator`](app/validators/account_kit.ts). A verified social signup may
instead consume a matching invitation automatically. See the [social invitation scenario map](../../docs/social-authentication.md#signing-in-with-the-invited-address).

The [token reference](../../docs/token-reference.md) and [session reference](../../docs/session-reference.md) walk through bearer and
browser clients.

## How the example works

Before adapting these routes, configure trusted proxy addresses so `request.ip()` cannot be spoofed.
Login counts failed attempts only: ten per client and five per client plus normalized email per
minute, with a 20-minute identity block. Limiter keys are HMACs derived from `APP_KEY` and do not
persist email addresses or client IPs. The password reset limiter also uses `request.ip()` as its
client key. Keep `APP_URL` on HTTPS in production so generated links are secure. Set
`ACCOUNT_KIT_AUTH_STRATEGY=session` to use the existing `web` guard, a server-side session store,
CSRF bootstrap, and HTTP-only browser cookies; the default uses the existing `api` bearer-token
guard. The cookie session store is rejected because it cannot invalidate a replayed cookie on
logout. See [authentication integration](../../docs/authentication.md) for setup, route protection,
revocation, and client handling, and [token API reference](../../docs/token-reference.md) for bearer requests, proof
confirmation, error formats, and log redaction. The example permits a limited inactive credential to correct an
unconfirmed email, while `VerifiedAccountMiddleware` rejects it on verified routes. Bearer tokens
must have the `invitations:create` ability before the invitation-send controller acts.
The [session reference](../../docs/session-reference.md) gives the browser bootstrap, cookie, logout, and application-route
revocation walkthrough.

The credential-notice outbox stores password-reset and password-change operation IDs, kinds, and
recipient addresses; it does not store passwords or bearer tokens. In token mode, package credential
changes delete API tokens transactionally; in session mode they advance the session revision. In
this example, the old-address email-change security
notice remains best-effort post-commit; an application that needs durable delivery must persist the
previous recipient transactionally in its own outbox recipe.

The sample dispatcher leaves failed rows pending and stops at the first failed row, so later rows
wait for another run. A production worker needs per-row failure handling and backoff. The dispatcher
uses `operationId` as an idempotency key, while its captured transport keeps delivered IDs in memory
only to simulate an idempotent external receiver during the crash-and-retry test. A production
receiver must persist idempotency keys across restarts, and its worker must coordinate concurrent
claims (for example with row locking or a lease); the in-memory set and sample dispatcher do not
provide those production guarantees.

## Social sign-in

The [social reference](../../docs/social-reference.md) connects Google and GitHub through Ally and
the package's social services. It includes application-owned routes for browser sessions and token
clients, a deterministic provider fixture for the functional suite, and the live-provider smoke
procedure. Set provider credentials and the exact OAuth callback URI before a live check.

## Test harness

This is the application-owned Adonis 7 API example used by the packed-consumer gate. It includes
routes, validation, central error mapping, a maintained lazy Lucid user adapter, captured
notifications, migrations, and HTTP flow tests. The test harness copies this fixture outside the
repository, inserts the exact candidate tarball as its `adonisjs-account-kit` dependency, runs the
package configure command, and tests the installed package. It never resolves the repository source
or reuses this checkout's `node_modules`.

Use the repository's `test:consumer` script to run it. PostgreSQL runs require the dedicated
`account_kit_consumer` database; the harness resets its `public` schema before each independent
scenario.
The `compatibility/` folder is an input for this harness, not part of the application: it is a
separate minimum-version consumer.
