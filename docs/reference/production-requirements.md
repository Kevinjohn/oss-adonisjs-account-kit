# Production requirements

Supported versions, required stores and default limiter budgets. For the procedures, see
[operations](../operations.md).

## Configuration

Production support is limited to the tested points and declared peer ranges in
[compatibility](../compatibility.md). Account Kit requires Node.js 24 or later, AdonisJS Core 7,
Lucid 22.4.2 or later in the 22.x line, Limiter 3, and Luxon 3. PostgreSQL and SQLite are
supported, and MySQL 8.4 is experimental, with the schema and connection requirements listed there. Use the same database and
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
behavior is intended, such as isolated tests. See [authentication](../authentication.md) and
[managed HTTP](../managed-http.md) for the guard and request contract.

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
do not trust arbitrary forwarded-IP headers. See [password reset and invitation rules](../usage.md#a-reset-link-works-once-then-expires).
