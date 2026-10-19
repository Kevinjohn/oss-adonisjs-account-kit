# Operations

How to deploy, prune, act as an operator, rotate secrets and redact diagnostics. The
[production requirements](reference/production-requirements.md) list the supported versions,
stores and limiter budgets; [production boundaries](production-boundaries.md) explain what the
package guarantees about readiness, delivery and revocation.

## Run in production

### Deployment prerequisites

Before serving traffic, apply and verify the generated migrations, configure the database and
limiter stores, complete every enabled notification callback, and verify generated URLs use the
public HTTPS origin. In a multi-instance deployment, instances must share the same account database,
limiter store, limiter secret and namespace, and (when using sessions) server-side session store.
Keep application configuration and provider credentials consistent during a deployment.
Take a recoverable database backup before migration and verify the restore procedure; migration
`down()` methods may not restore migrated data. See the [upgrade rollback boundary](upgrade.md#rollback-boundary).

Review the final physical user table shown in setup's preview, whether explicitly chosen or the
selected default, against the effective model and generated migration target before migration.
Setup's automatic Lucid model inspection is static and conservative; custom class metadata or other
dynamic initialization needs manual reconciliation because inspection cannot certify model metadata
produced at application boot. See [how setup works](how-setup-works.md) for the supported model shapes.

Run `node ace account-kit:setup --check --production` as a source preflight while the parser and
application configuration are available. It inspects TypeScript without executing application
configuration and resolves only the selected `DB_CONNECTION` and `SESSION_DRIVER` from process
environment and application environment files. It cannot prove which settings a compiled deployment
will use, that migrations ran, or that external services and callbacks work. Unsupported dynamic
expressions, interpolation, linked or ambiguous environment files, and unresolved selections need
manual reconciliation. An unknown or unsupported selected database is a blocking setup diagnostic;
resolve the actual default SQLite, PostgreSQL 16 or MySQL 8.4 client before applying setup. Confirm the actual
deployed database and session store, applied migrations,
runtime route graph, callbacks, and selected workflows independently before production readiness.

For the session guard, configure AdonisJS Shield with `csrf.enabled` resolving to `true` at runtime.
The conventional example enables it when `ACCOUNT_KIT_AUTH_STRATEGY=session`; a setup preview can
flag conditional or dynamic Shield configuration for manual verification. The middleware chain
must run BodyParser, session, Shield, then auth. A session client fetches the managed CSRF bootstrap
endpoint only after the managed route mount is active. While
`authentication.applicationRouteRevocation` is false, use an application-owned CSRF bootstrap route
as described in the [revocation bootstrap procedure](setup.md#prove-revocation-before-route-activation);
keep an application-owned replacement when `auth.csrf` is excluded. Retain the session cookie and
send the returned token in `x-csrf-token` on state-changing requests. Managed session handlers fail
closed if Shield has not established CSRF state. JSON responses and CORS policy do not replace CSRF
protection. Confirm this against the running production configuration, including TLS termination and
secure cookies. Setup places `account_kit_proof_headers_middleware` first in `server.use`, before
BodyParser or other middleware that can terminate a proof request; retain that order. An excluded or
application-owned proof route needs equivalent early response headers, including on parser and CSRF
failures.

Managed routes default `verificationRequired` to `true`. Routes marked `active` then reject inactive
accounts. Setup generates `managedAccountMiddleware` for application-owned protected routes with
its `active` option matching `verificationRequired` (true by default). Keep that middleware on
every route that requires verified accounts or credential-revision checks. If
`verificationRequired` is deliberately disabled, use the same `active` setting on managed and
application-owned routes. A route that omits the middleware is outside those package guarantees.

Leave `authentication.applicationRouteRevocation` false for the first apply. Setup generates the
guard and account-access middleware with an inert `start/account_kit_routes.ts`; no managed routes
are mounted and the endpoint inventory is empty. Review and run the generated migrations, attach the
middleware to a temporary application-owned protected route, then follow the [revocation bootstrap
procedure](setup.md#prove-revocation-before-route-activation). It uses the public Account Kit login
through the generated guard: native guard login or `loginAs` alone does not enroll the package
credential revision. Use the public revocation operation for the selected capability: change the
password when `emailPasswordManagement` is selected, complete a delivered reset when only
`passwordReset` is selected, or restrict and then restore the account when authentication alone is
selected. For the restriction path, require a fresh credential to succeed after restoration and the
original credential to receive 401; denial only while the account remains restricted does not prove
revocation. For every path, first verify the original credential succeeds and then verify that same
credential is denied after the change. Register the generated access-middleware class from
`app/middleware/account_kit_access_middleware.ts` in the `start/kernel.ts` named map and apply its
`handle` implementation to the route. Remove or secure the temporary test route before production.
Only after this check set `authentication.applicationRouteRevocation` to true and rerun setup to
activate the managed route mount. File generation or a successful
typecheck does not prove runtime revocation. Setup does not ingest runtime results and always reports
`workflowVerified` as false; record the operator's workflow evidence separately.

With Mail's default in-memory messenger, a later transport failure emits `queued:mail:error` after
the account operation has returned. Subscribe to that event or the application's transport logs and
record a private, redacted failure; do not treat queue acceptance as successful recipient delivery.

### Expired-row pruning

The explicit `account-kit:prune` Ace command removes expired password reset, invitation,
email-verification (activation and email change), social transaction, sensitive-action proof,
social handoff-code, sign-in link and session sign-in rows in bounded batches. It is not scheduled automatically. Defaults are
100 rows per batch and at most 100 batches; each setting accepts a value from 1 through 1000. Use
the command's dry-run option to estimate eligible rows before deletion. A daily run is a
reasonable starting schedule if expired proofs should be removed; tune frequency and batch limits
to retention and database load, then schedule the command through the application's maintenance
mechanism.

```sh
pnpm exec node ace account-kit:prune --dry-run
pnpm exec node ace account-kit:prune
```

The command captures one expiry cutoff for the run, selects IDs in bounded batches, and rechecks
that each row is still expired at deletion time. Output reports all seven row counts, showing rows
actually deleted (or rows eligible in dry-run mode). It does not delete users, social identities,
access tokens, web sessions, team memberships, or application-owned records. If a run reaches its
batch cap, schedule another run rather than raising the cap without considering database load.

Run `pnpm exec node ace account-kit:prune --help` in the configured application to see the
installed command options.

### Operator commands

Two booted Ace commands let someone with shell access act without the HTTP surface, for example to
bootstrap the first administrator or help a locked-out user. They run in operator context: no actor
authorization callback and no rate limit applies, so never expose the underlying
`kit.operator` services to an HTTP request. Each command still requires its capability
(`invitations` or `passwordReset`) and the configured URL and notification callbacks.

```sh
pnpm exec node ace account-kit:invite admin@example.com --role=admin
pnpm exec node ace account-kit:invite admin@example.com --role=admin --print
pnpm exec node ace account-kit:reset-link person@example.com
pnpm exec node ace account-kit:reset-link person@example.com --print
```

By default the link is emailed through the configured `notify` callback. `--print` prints it
instead and sends nothing; the link is never both sent and printed. Each command writes one JSON
line to stdout (`result`, identifiers, `expiresAt` for invitations, and `url` with `--print`) and
writes warnings and errors to stderr, so the output can be piped. A printed link is a bearer
secret: share it only over a trusted channel.

- `account-kit:invite` replaces any invitation already issued for the address, so rerunning it
  after a lost link works. The invitation has no inviter (`inviterId` is `null`). It refuses an
  address that already has an account. The role becomes the invitation role; assign application
  roles in `onInvitationAccepted`, as for any invitation.
- `account-kit:reset-link` reports an unknown address (`E_ACCOUNT_KIT_USER_NOT_FOUND`) instead of
  answering generically, and skips the timing floor. It replaces the account's live reset link and
  runs `onPasswordResetIssuedTransaction`. Completing a reset activates an account that has not
  verified its email; the command warns when that applies.

If the row commits but a follow-up (delivery or `onLifecycleEvent`) fails, the command still prints
the committed result, including the link with `--print`, adds a `fault` with the error name and
message, and exits with status 1. Lifecycle events from these commands carry `source: 'operator'`.

### Secret rotation

Account Kit stores hashes of random, one-use proof tokens; it does not encrypt or sign those proofs
with `APP_KEY`. Preserving the proof rows and schema therefore preserves outstanding proofs through
an upgrade. A change to `tokenSecretLength` affects newly issued token size and is not a key
rotation; coordinate configuration changes across instances and verify generated URLs and clients.

The configured `limiterSecret` derives limiter keys. Rotating it changes every derived key and
effectively resets the corresponding throttling budgets. Rotate it deliberately, keep all instances
on one value, and expect a temporary fresh budget. When `APP_KEY` is also used for AdonisJS session
or encryption cookies, follow the application's key-rotation procedure: that effect belongs to the
application framework and is separate from Account Kit proof validation. Provider client secrets
belong to application/provider configuration. A selected provider marked `approved-pending` has no
production handshake guarantee; handle provider credential rotation only after its separate
integration and verification are complete.

### Diagnostics and redaction

Proof URLs contain bearer credentials in their path and must be redacted from request paths and
queries at the frontend, reverse proxy, access logger, analytics, and error-reporting boundaries.
Do not log passwords, full bearer or action tokens, provider secrets, raw provider profiles, or
unnecessary personal data. AdonisJS Mail's `mail:queueing` and `mail:queued` event payloads can
include rendered message bodies and proof links; do not log those payloads wholesale. Record only
allowlisted, redacted diagnostic fields such as message kind, transport outcome, and an application
correlation ID. A correlation ID is diagnostic data, never authentication material. See
[notifications](notifications.md) for exact delivery failure behavior.

## Files delta

This operational guide adds no generated application files. Configure continues to create or
preserve application-owned configuration and migration files; review their contents and the
application's worker, mail, limiter, session, and revocation setup.

## Manual steps

Use the deployment and rotation procedures above in a staging environment first. Verify a throttled
request, an outstanding proof, a credential change, the selected session/token revocation behavior,
and scheduled pruning using the application's real stores and callbacks. Add alerts and retry policy
to any application-owned notification dispatcher.

## Changelog

- Unreleased: document production stores, worker and pruning responsibilities, credential effects,
  and secret rotation behavior.
