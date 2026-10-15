# Usage

`AccountKit` is registered by the package provider and resolved from the Adonis container. The
complete application wiring is in the [API consumer example](../examples/api/README.md), including
routes, validation, central HTTP error mapping, Lucid model setup, and notification callbacks.

## Configuration

`expiresIn` accepts positive duration strings or seconds for each feature. The defaults remain:

```ts
expiresIn: {
  passwordReset: '1h',
  emailVerification: '1h',
  invitation: '7d',
  emailChange: '1h',
}
```

For example, `expiresIn: { passwordReset: 3600 }` has the same lifetime as `'1h'`.
Keep application password rules, throttle budgets, and notification delivery policy explicit.

The callback names distinguish a link provision from a completed-operation notice:

| Purpose                   | URL callback             | Notification callback               |
| ------------------------- | ------------------------ | ----------------------------------- |
| Forgot password link      | `urls.passwordReset`     | `notify.passwordResetProvision`     |
| Password reset completed  | —                        | `notify.passwordResetCompleted`     |
| Account activation link   | `urls.emailVerification` | `notify.accountActivationProvision` |
| Invitation link           | `urls.invitation`        | `notify.invitationProvision`        |
| Email-change confirmation | `urls.emailChange`       | `notify.emailChangeProvision`       |
| Email changed             | —                        | `notify.emailChanged`               |
| Password changed          | —                        | `notify.passwordChanged`            |

### Capabilities

`enabled` accepts any unique subset of `passwordReset`, `emailVerification`, `invitations`, and `emailPasswordManagement`.
It defaults to all four. Configuration validates callbacks needed by enabled capabilities only;
calling an operation from a disabled capability rejects with `CapabilityDisabledError`.

The service methods accept structured inputs. The usual calls are:

```ts
await kit.passwordReset.request({ email, clientKey })
const valid = await kit.passwordReset.inspect({ token })
const user = await kit.passwordReset.reset({ token, password })

await kit.emailVerification.send({ userId })
await kit.emailVerification.complete({ token })

const invitation = await kit.invitations.send({ actorId, email, role })
const page = await kit.invitations.list({ actorId, limit: 25 })
const preview = await kit.invitations.inspect({ token })
const newUser = await kit.invitations.accept({ token, password, registrationData })
await kit.invitations.resend({ actorId, invitationId: invitation.id })
await kit.invitations.revoke({ actorId, invitationId: invitation.id })

await kit.emailPasswordManagement.changePassword({ actorId, currentPassword, newPassword })
await kit.emailPasswordManagement.requestEmailChange({ actorId, currentPassword, newEmail })
await kit.emailPasswordManagement.completeEmailChange({ token })
```

Invitation listing returns `{ items, nextCursor }`. The default page limit is 25 and the maximum is 100. Pass `nextCursor` as `cursor` to fetch the next page; `null` means there are no more rows.

Pages use a cursor over creation time and invitation ID, but each page is a separate query, not a
snapshot. Invitations created, revoked, or expired between requests can change later page results.

## How it works

### A reset link works once, then expires

Password reset requests consume both a client-key budget and a normalized-email budget. A throttled
request does not replace the currently stored password reset token, so an already-issued unexpired link
remains redeemable. A later successful issuance rotates the user's token and invalidates its
predecessor.

Build the password reset `clientKey` from `request.ip()` only after configuring Adonis trusted proxies
for the known proxy addresses and forwarded-header policy. Do not accept a client-provided key or
trust arbitrary `X-Forwarded-For` headers. Keep `APP_URL` set to the public HTTPS origin and build
links from that configured value, not from request `Host` or forwarded-host headers.

Invitation email uniqueness is global to this package's invitation table, not tenant-scoped. Sending
an invitation to an address that already belongs to a user is rejected; a normalized address can
have only one pending invitation. Acceptance does not recheck the inviter's authorization. The
application's `onInvitationAccepted` callback assigns the opaque invitation role; the package does
not create tenant or team membership records unless the application callback does so.

## Adapter and registration data

Prefer `createLucidAdapter(async () => (await import('#models/user')).default, options)` for Lucid
users. It resolves the model lazily, derives its physical table and requires the default Lucid
connection and an `id` primary-key column. Add
`mapRegistrationData(data, user)` only when account creation needs additional required profile
fields. The callback receives untrusted registration data and the new model instance. Explicitly
validate and assign known fields; never spread request data onto the model. The adapter controls
`id`, `email`, `password`, `emailVerifiedAt`, and `role`. Passwords are set through normal model
save hooks so the application's hashing hook runs once.

If using a custom adapter, implement normalized email equality, a unique email constraint, password
hashing, and transaction-aware reads/writes. Provide `resolveMetadata()` with the physical table
and `primaryKey: 'id'`, or configure `usersTable` as the metadata fallback. The package acquires
the PostgreSQL user-row lock centrally from that metadata; SQLite uses its package-owned singleton
transaction lock. See the emitted [`UsersAdapter` declaration](../build/src/types.d.ts) and
[adapter compatibility declaration](../build/testing/adapter_contract.d.ts).

## Authorization and callbacks

Authorization callbacks must return exactly `true` to allow. Use `actorId` inputs so the package
loads the actor via the adapter. Invitation resend performs a preflight authorization transaction,
charges limiter budgets after that transaction commits, then locks and reauthorizes before changing
the invitation. Its callbacks can therefore run in both phases; SQLite transaction retries can call
them again. Keep them read-only and repeatable, and use the optional authorization context's `trx`
to read current permission state in each phase. The package locks the invitation row, not
application permission records; lock mutable permission rows through `trx` when the application's
policy requires serialization. The limiter runs outside the write transaction to avoid a
same-database limiter deadlock with a one-connection SQLite pool.

`onPasswordResetIssuedTransaction(user, trx)` is an optional hook for password reset issuance. After the
issuance limiter and initial email lookup, the package starts its root transaction, locks and
reloads that user, confirms the requested email still matches, and replaces the token before
calling the hook. The hook can check current authority and eligibility and write an audit or
command claim through `trx`. Throwing rolls back the replacement, preserving the previous link.
SQLite may retry the callback, so keep it database-only and repeatable. URL generation,
notification and bearer capture run only after a verified commit.

`onInvitationAccepted(user, invitation, trx)` runs inside the acceptance transaction. Use `trx`
for all application writes, such as role assignment. Throwing rolls back both the account and
application writes.

The package admits passwords of 8–256 UTF-16 units without changing their bytes. Applications
may enforce their own narrower policy before calling it.

Use `onCredentialsChangedTransaction(user, context, trx)` for token/session revocation that must
commit atomically with a password or email change. The context contains `operation`,
`operationId`, and `userId`. It is mutually exclusive with the legacy
`onCredentialsChanged(user, context)` post-commit callback. The package also invokes the dedicated
`notify.passwordResetCompleted` or `notify.passwordChanged` notice for the corresponding password
operation.

`onLifecycleEvent(event)` receives safe event identifiers after commit. Payloads contain IDs and an
operation ID, not tokens, email addresses, passwords, or notification URLs. Treat this callback as
best-effort post-commit delivery; use a transactional outbox if the consumer requires durable
delivery.

## Transactions and callbacks

Package write operations manage their own root transactions and reject execution inside an active
global transaction. All adapter methods receiving `trx` must use that transaction. Keep database
writes in `onInvitationAccepted` and the transaction-aware credential hook inside the supplied
transaction. Do not send mail or call external services from transaction callbacks.

SQLite uses the package-owned `account_transaction_lock` singleton row to serialize account
transactions, then may retry write contention. Therefore transaction callbacks can run more than
once and must be repeatable. The lock migration must be applied before package writes. PostgreSQL
uses row-level locks and does not retry failed transactions. Transient database errors can
propagate on either dialect.

Notifications and lifecycle callbacks run after commit. A `DeliveryError` means a notification
could not be delivered; a `PostCommitError` means a post-commit callback failed after the database
change committed and exposes `committed: true`. Do not retry a committed account mutation as if it
had rolled back. If delivery must survive process failure, write an outbox row in the transaction
and deliver it from an application-owned worker. See the
[operations guide](operations.md#durable-notifications).

## HTTP and error handling

The package does not define application routes, request validators, session policy, or password
requirements. Validate request bodies and path IDs in the application. Map package errors centrally
using their `E_ACCOUNT_KIT_*` code and status metadata; do not expose internal messages or causes.
At the HTTP boundary, map missing and unauthorized invitation-management results to the same
not-found code and response body to avoid revealing the invitation's existence. The exception
classes retain separate codes for application-side diagnosis.

| Error                             | Code                                         | Status |
| --------------------------------- | -------------------------------------------- | -----: |
| `InvalidInputError`               | `E_ACCOUNT_KIT_INVALID_INPUT`                |    422 |
| `InvalidTokenError`               | `E_ACCOUNT_KIT_INVALID_TOKEN`                |    422 |
| `ThrottledError`                  | `E_ACCOUNT_KIT_THROTTLED`                    |    429 |
| `AuthorizationError`              | `E_ACCOUNT_KIT_AUTHORIZATION`                |    403 |
| `InvitationManagementDeniedError` | `E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED` |    404 |
| `InvitationNotFoundError`         | `E_ACCOUNT_KIT_INVITATION_NOT_FOUND`         |    404 |
| `IdentityNotConfirmedError`       | `E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED`       |    403 |
| `NoPasswordError`                 | `E_ACCOUNT_KIT_NO_PASSWORD`                  |    403 |
| `EmailAlreadyRegisteredError`     | `E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED`     |    409 |
| `InvitationPendingError`          | `E_ACCOUNT_KIT_INVITATION_PENDING`           |    409 |
| `DeliveryError`                   | `E_ACCOUNT_KIT_DELIVERY`                     |    500 |
| `PostCommitError`                 | `E_ACCOUNT_KIT_POST_COMMIT`                  |    500 |
| `CapabilityDisabledError`         | `E_ACCOUNT_KIT_CAPABILITY_DISABLED`          |    500 |

`ThrottledError` also exposes `retryAfterSeconds`. `PostCommitError` exposes `committed: true`.
`CapabilityDisabledError` usually indicates a route or operation is enabled without its
corresponding capability; it is generally an application configuration issue and should not be
returned as a generic server detail.

Password reset request endpoints must always return the same generic acknowledgement for known and unknown
accounts. Suppress both `DeliveryError` and `PostCommitError` for that operation at the HTTP
boundary, then return the acknowledgement. Do not return error codes, delivery status, or callback
details to the requester. `minRequestMs` defaults to 300ms as a mitigation against timing
differences; it is not a guarantee that all requests take the same time.

See the [API controller example](../examples/api/app/controllers/account_kit_controller.ts) for
illustrative route behavior. Adapt it to the application's own transport and error response
conventions.

## Files delta

Configure generates `config/account_kit.ts` and five package migration files. The reset-token
stub is `create_password_reset_tokens.stub` and generates
`*_account_kit_create_password_reset_tokens.ts`, creating `password_reset_tokens`. Its columns
are unchanged. Existing application-owned config and migration files are preserved.
The implementation lives in `src/password_reset.ts`; import the public `AccountKit` and input
types from the package root or its documented type entry point.

## Manual steps

Implement the callbacks for enabled capabilities, adapt application calls and imported input
types, and update lifecycle listeners to `password_reset.requested`. The email-verification event
remains `verification.completed`; all other lifecycle events and `E_ACCOUNT_KIT_*` error codes
also retain their names. An inactive account becomes active when its current email is verified;
this rename retains the existing `emailVerifiedAt` state representation.

Existing installations must also rename their reset-token table in a controlled migration.
Follow the [vocabulary upgrade steps](upgrade.md#vocabulary-alignment) before enabling the new
code. No old service names, exported input aliases, or dual config keys are supplied.

## Changelog

The [Unreleased rename list](../CHANGELOG.md#unreleased) records every breaking public rename.
The forgot password, email-verification, email and password management, and invitation operations
retain their existing responses, defaults, proof semantics and security rules.
