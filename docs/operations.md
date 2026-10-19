# Operations

## Configuration

Production support is limited to the tested points and declared peer ranges in
[compatibility](compatibility.md). Account Kit requires Node.js 24 or later, AdonisJS Core 7,
Lucid 22.4.2 or later in the 22.x line, Limiter 3, and Luxon 3. PostgreSQL, MySQL 8.4 and SQLite are
supported with the schema and connection requirements listed there. Use the same database and
schema across application instances.

The setup command needs the optional TypeScript parser to inspect application source: TypeScript
5.9.3 or newer in major version 5, or 6.0.3 or newer in major version 6. Install it for setup with
`pnpm add -D typescript@^5.9.3` (or `pnpm add -D typescript@^6.0.3`). The parser loads only when
setup runs; other Account Kit entry points do not require it. Run setup preview and `--check` in a
source, development, or CI environment before production dependency pruning. A compiled deployment
without the parser or source configuration is not a supported setup-check environment.

Every instance must load the same non-secret Account Kit configuration. Set `limiterSecret` to a
stable secret of at least 32 bytes and keep `limiterNamespace` and throttle budgets consistent.
Applications using the session guard need a server-side AdonisJS session store that can destroy the
current session; the encrypted-cookie store is rejected because it cannot provide logout replay
protection. Managed session authentication also requires
`protectManagedSessionConfig` around the selected provider in `config/session.ts`, before
SessionMiddleware starts. Its `verifyStore(actual)` callback must attest that the actual selected
store centrally revokes destroyed session IDs; a `destroy` method by itself is not proof. The
wrapper rejects cookie-backed stores, including aliases and subclasses. Setup can generate this
wrapper for conventional `defineConfig` session configuration and recognize its inspected database
or development-memory selection, but static inspection does not prove actual revocation behavior.
A database session store needs its table migration applied. Memory storage is for development only;
production requires persistent shared session storage. Unsupported custom or dynamic syntax blocks
`account-kit:setup --apply`. Convert it to the supported conventional shape to use automated setup.
If retaining custom syntax, manually integrate the public wrapper and an application-owned verifier
against the actual selected store, then manage the remaining setup changes separately and verify
logout replay at runtime. For multiple instances, use the same server-side store. Configure Shield
CSRF verification for session requests
that establish authentication or change state. Keep BodyParser, session, Shield, then auth middleware
in that order. The setup session-policy booleans record operator checks; they do not configure the
session backend or prove it works at runtime. Use a shared limiter store when limits must apply across
instances. An in-memory store gives each process its own budgets and is suitable only where that
behavior is intended, such as isolated tests. See [authentication](authentication.md) and
[managed HTTP](managed-http.md) for the guard and request contract.

Installing `@adonisjs/limiter` does not configure its runtime service. If it is missing, run
`pnpm add @adonisjs/limiter` followed by `pnpm exec node ace configure @adonisjs/limiter`; verify
its provider is registered and
`config/limiter.ts` uses `defineConfig` with the selected, configured store. Setup choices that
enable authentication also require an application-owned `accountKitPolicy.canAccess(user, trx)`
callback that evaluates the real restricted-account policy. Invitation routes additionally require
`authorize` and `onInvitationAccepted`; do not use an allow-all placeholder.

The application supplies mail delivery through the configured `notify` callbacks and constructs
proof URLs through `urls`. Use an HTTPS application URL in production and configure trusted proxy
addresses before deriving client keys from request IPs. Account Kit does not install or configure a
mail transport, queue, outbox, or background worker. Setup uses `FRONTEND_URL` as the conventional
trusted frontend origin environment-variable name; a custom name can be selected. Production
backend and frontend origins must both resolve to HTTPS.

When email flows select maintained AdonisJS Mail, setup inspects the selected configuration before
activation. A missing mailer, plainly non-callable provider, unsafe configuration, or ambiguous
runtime binding blocks setup writes. An opaque custom factory or a recognized transport still needs
manual verification against the deployed configuration and a real delivery check; static
inspection does not mark external delivery as configured.

For custom notification transport, export a `Partial<NotificationCallbacks>` and implement the
callbacks required by enabled features: `passwordResetProvision`, `accountActivationProvision`,
`emailChangeProvision`, `emailChanged`, `passwordResetCompleted`, and `passwordChanged`; invitation
support also needs `invitationProvision`. The development example writes bearer proof URLs and
recipient addresses to `tmp/account-kit-notifications.jsonl` with mode `0600`; it throws when
`app.inProduction` is true. Treat that file as secret-bearing local data, never commit it, and do
not report capture as delivery or production transport. Configure and verify real callbacks before
deployment.

Setup may mark a selected social provider `approved-pending`. That status is not production
readiness or a supported login handshake; provider operation and rotation need their separate
integration and verification before deployment.

## How it works

### Deployment prerequisites

Before serving traffic, apply and verify the generated migrations, configure the database and
limiter stores, complete every enabled notification callback, and verify generated URLs use the
public HTTPS origin. In a multi-instance deployment, instances must share the same account database,
limiter store, limiter secret and namespace, and (when using sessions) server-side session store.
Keep application configuration and provider credentials consistent during a deployment.
Take a recoverable database backup before migration and verify the restore procedure; migration
`down()` methods may not restore migrated data. Prefer forward recovery; to go back, restore that
backup instead of running `down()`.

Review the final physical user table shown in setup's preview, whether explicitly chosen or the
selected default, against the effective model and generated migration target before migration.
Setup's automatic Lucid model inspection is static and conservative; custom class metadata or other
dynamic initialization needs manual reconciliation because inspection cannot certify model metadata
produced at application boot. See [setup](setup.md) for the supported model shapes.

Treat setup readiness fields as separate evidence. `configurationValid` can be true while
`migrationsApplied`, `workflowVerified`, and `productionReady` are false; an `externalConfigured`
result is a static plan assessment, not a successful live transport or provider check. Apply
migrations separately, then verify real external integrations and account workflows in the target
environment before declaring the deployment ready. Presence of application-owned policy or
notification files does not establish their callback contracts or delivery behavior; keep those
checks unresolved until the selected flows are exercised against the running application.

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

Setup route inspection reads literal routes in `start/routes.ts`; it does not boot the application.
Grouped, imported, or programmatically generated routes require the package's committed Adonis
route-graph check during application boot, followed by exercising the selected endpoints. A passing
static `configurationValid` result does not certify that runtime route graph or set
`workflowVerified` or `productionReady`.

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

Account Kit has no required background worker. If the application uses an outbox for durable
notifications, the application must run and monitor its own dispatcher. The example outbox is an
illustration only: its in-memory receiver deduplication and simple dispatcher do not provide
production durability, backoff, or coordinated claims. Network delivery from a notification
callback happens after the account transaction commits but still affects the calling operation;
enqueue quickly when delivery must survive process restarts. The maintained AdonisJS Mail callbacks
use `sendLater`; their default delivery classification is `best-effort` and does not provide retries
or a durable outbox. Queue acceptance does not prove recipient delivery. `delivery: 'durable'` is
only an application-owned claim supported by its verified worker, retry, terminal-failure, action
link, and security-notice handling. See [notifications](notifications.md) for those limits and
the Mail integration contract.

With Mail's default in-memory messenger, a later transport failure emits `queued:mail:error` after
the account operation has returned. Subscribe to that event or the application's transport logs and
record a private, redacted failure; do not treat queue acceptance as successful recipient delivery.

### Limiter secret and budgets

Set `limiterSecret` to a stable secret of at least 32 bytes, normally the application's `APP_KEY`.
Account Kit derives HMAC-based keys with the configured `limiterNamespace` (default `default`) so
raw addresses, IPs, and identifiers are not used as limiter keys. Instances sharing a limiter store
must use the same secret and namespace. Rotating the secret changes derived keys and resets the
associated budgets; plan the rotation as a limiter reset.

The general request throttle defaults to five requests per 15 minutes. Invitation budgets default
to 10 sends per actor per hour, 3 sends per recipient per hour, 10 resends per actor per hour, and
3 resends per invitation per hour. Override individual budgets with `throttle` and
`invitationThrottle` in config. Keep budgets consistent across instances sharing limiter storage.

Password reset issuance is limited by both client key and normalized email. When a request is throttled,
the existing unexpired password reset link remains redeemable; the next successful issuance replaces it.
Use a client key derived from the request IP only behind correctly configured trusted proxies, and
do not trust arbitrary forwarded-IP headers. See [password reset and invitation rules](usage.md#a-reset-link-works-once-then-expires).

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

### Durable notifications

Callbacks in `notify` are post-commit. Enqueue work quickly rather than performing a slow network
delivery inline. If reliable delivery across process restarts is required, write an application
outbox row from `onCredentialsChangedTransaction` or another operation-specific transaction hook,
then have an application-owned worker claim and deliver outbox records. Make delivery idempotent
using the supplied `operationId` where available. The example application's outbox illustrates the
application-owned boundary; it is not a package-managed worker or delivery guarantee. Its durable
notice recipe covers password reset/change only. The example still attempts the email-change
security notice to the previous address after commit; that notice is best-effort. To make it
durable, an application must capture the previous recipient inside the email-update transaction
and persist a distinct notice intent. The captured test transport simulates an idempotent receiver;
production delivery requires durable receiver deduplication and coordinated worker claims.

If a post-commit callback fails, the operation may already have committed. `PostCommitError` marks
this with `committed: true`; do not blindly retry the mutation. Password reset request handlers are the
exception: suppress both `DeliveryError` and `PostCommitError` and return the generic accepted
response to preserve account-existence privacy.

### Session, token, and membership lifecycle

Credential-changing Account Kit operations invoke the configured credential-change hook. Use
`onCredentialsChangedTransaction` to update application-owned credentials in the same transaction
when atomic revocation is required; its return path is exclusive with the post-commit
`onCredentialsChanged` hook. The session guard compares the session's credential revision with the
user's current revision. The token guard checks that native authentication's token row remains in
the configured table; credential-changing token operations revoke it by deleting the user's rows in
that table transactionally. Direct database writes bypass these effects. Route account changes
through Account Kit operations or make equivalent application changes to token-row deletion,
session-revision updates, and other application-owned credential state in the same transaction.

The package does not universally terminate browser sessions or alter team memberships. Browser
session-store cleanup, API token policies beyond the configured hook, tenant membership cleanup,
and other application identity rules remain application responsibilities. A notification or
post-commit hook failure can be reported after account state has committed; inspect the error's
committed status and never blindly repeat the account mutation.

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
