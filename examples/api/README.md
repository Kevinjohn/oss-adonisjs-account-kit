# Account API example

A complete AdonisJS 7 API app that uses Account Kit from its own controllers. Copy from it when
you wire Account Kit into your app; the [usage guide](../../docs/usage.md) points here for the
full picture.

For a single supported API-starter journey with one namespace and the opaque `api` guard, begin
with [Build one account API](../../docs/guides/core-api.md). This example has additional admission,
invitation, social, and outbox integrations; copy those only when your application needs them.

## What to copy

| You want                         | Look at                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The config                       | [`config/account_kit.ts`](config/account_kit.ts)                                                                                                                     |
| Routes and middleware placement  | [`start/routes.ts`](start/routes.ts), [`start/kernel.ts`](start/kernel.ts)                                                                                           |
| Controllers for each flow        | [`app/controllers/`](app/controllers)                                                                                                                                |
| Request validation               | [`app/validators/`](app/validators)                                                                                                                                  |
| Mapping errors to HTTP responses | [`app/exceptions/handler.ts`](app/exceptions/handler.ts)                                                                                                             |
| Session and token guard adapters | [`app/services/account_kit_guards.ts`](app/services/account_kit_guards.ts)                                                                                           |
| Email callbacks and an outbox    | [`app/services/account_kit_notifications.ts`](app/services/account_kit_notifications.ts), [`app/services/account_kit_outbox.ts`](app/services/account_kit_outbox.ts) |
| Signing out old credentials      | [`app/middleware/account_access_middleware.ts`](app/middleware/account_access_middleware.ts)                                                                         |
| HTTP tests for every flow        | [`tests/functional/`](tests/functional)                                                                                                                              |

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
