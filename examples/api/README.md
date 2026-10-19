# Account API example

A complete AdonisJS 7 API app that uses Account Kit from its own controllers. Copy from it when
you wire Account Kit into your app; the [usage guide](../../docs/usage.md) points here for the
full picture.

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

Use the repository's `test:consumer` script to run it. A separate baseline tarball is required to
run the upgrade scenario. PostgreSQL runs require the dedicated `account_kit_consumer` database;
the harness resets its `public` schema before each independent scenario.
The `compatibility/` and `upgrade/` folders are inputs for this harness, not part of the
application: `compatibility/` is a separate minimum-version consumer, and `upgrade/` holds the
baseline files for the upgrade scenario.
The historical baseline config is kept in `upgrade/baseline_account_kit.stub` so current-app
typechecking does not compile old package contracts. The upgrade harness copies that stub into
the temporary application config only for its baseline phase.
The upgrade scenario uses an application-owned handler compatible with the preserved baseline
package, then exercises password reset through its preserved config and adapter before hashing the
baseline config and migration files. It verifies configure preserves them, then applies the
maintained candidate config, password-reset controller and exception handler as documented manual upgrade steps.
It changes the newly generated reset-token migration to rename the existing table, preserving rows
and applied migration files, before booting and typechecking the candidate. The candidate-phase test verifies the recovered password,
user data, role assignment, and application migration record survived. It also carries a live reset
proof through the table rename, compares every stored row field, redeems that proof once, and
rejects replay. The proof is transferred between phases in a mode-0600 temporary file and removed
before redemption assertions.
