# Usage

`AccountKit` is registered by the package provider and resolved from the Adonis container. The
complete application wiring is in the [API consumer example](../examples/api/README.md), including
routes, validation, central HTTP error mapping, Lucid model setup, and notification callbacks.
See [authentication integration](authentication.md) for the selected guard, session/CSRF
bootstrap, token handling, revocation, and required route middleware.

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

For maintained AdonisJS Mail callbacks, templates, trusted links and delivery classification,
see [account notifications](notifications.md).

The callback names distinguish a link provision from a completed-operation notice:

| Purpose                   | URL callback             | Notification callback               |
| ------------------------- | ------------------------ | ----------------------------------- |
| Forgot password link      | `urls.passwordReset`     | `notify.passwordResetProvision`     |
| Password reset completed  | —                        | `notify.passwordResetCompleted`     |
| Account activation link   | `urls.emailVerification` | `notify.accountActivationProvision` |
| Invitation link           | `urls.invitation`        | `notify.invitationProvision`        |
| Email-change confirmation | `urls.emailChange`       | `notify.emailChangeProvision`       |
| Email changed             | —                        | `notify.emailChanged`               |
| Magic sign-in link        | `urls.magicLink`         | `notify.magicLinkProvision`         |
| Password changed          | —                        | `notify.passwordChanged`            |
| Account deleted           | —                        | `notify.accountDeleted`             |

### Capabilities

`enabled` accepts any unique subset of `passwordReset`, `emailVerification`, `invitations`,
`emailPasswordManagement`, `registration`, `socialAuthentication`, `magicLinkLogin`,
`sessionManagement`, `dataExport` and `accountDeletion`. `magicLinkLogin` and `sessionManagement`
are off by default and require `authentication`; see [magic-link sign-in](magic-link.md) and
[signed-in devices](signed-in-devices.md). `dataExport` and `accountDeletion` are off by default;
see [account export and deletion](account-data.md). When omitted, registration and invitations are
disabled; applications select either explicitly. Every configuration supplies
`registration.availability`, even when registration is disabled. Configuration validates callbacks needed by enabled capabilities only;
calling an operation from a disabled capability rejects with `CapabilityDisabledError`.
An `emailVerification`-only adapter needs `findById`, `markEmailVerified`, and `setPassword`, but
does not need `setEmail`. Inactive activation replaces the earlier password with a fresh one;
active-account email changes retain their separate proof behavior.

The service methods accept structured inputs. The usual calls are:

```ts
await kit.passwordReset.request({ email, clientKey })
const valid = await kit.passwordReset.inspect({ token })
const user = await kit.passwordReset.reset({ token, password })

await kit.emailVerification.send({ userId })
const activationValid = await kit.emailVerification.inspect({ token })
await kit.emailVerification.complete({ token, password: freshPassword })

const invitation = await kit.invitations.send({ actorId, email, role })
const page = await kit.invitations.list({ actorId, limit: 25 })
const preview = await kit.invitations.inspect({ token })
const newUser = await kit.invitations.accept({ token, password, registrationData })
await kit.invitations.resend({ actorId, invitationId: invitation.id })
await kit.invitations.revoke({ actorId, invitationId: invitation.id })

await kit.emailPasswordManagement.changePassword({ actorId, currentPassword, newPassword })
const profile = await kit.emailPasswordManagement.updateProfile({
  actorId,
  currentPassword,
  email,
  registrationData,
})
await kit.emailPasswordManagement.requestEmailChange({ actorId, currentPassword, newEmail })
const emailChangeValid = await kit.emailPasswordManagement.inspectEmailChange({ token })
await kit.emailPasswordManagement.completeEmailChange({ token })

await kit.magicLink.request({ email, clientKey, clientChallenge })
const linkValid = await kit.magicLink.inspect({ token })
const { account, credential } = await kit.magicLink.complete({ token, verifier }, guard)
const signIns = await kit.authentication.sessions.list({ current })
await kit.authentication.sessions.revoke({ current, id })
await kit.authentication.sessions.revokeOthers({ current })
await kit.authentication.sessions.revokeAll({ current })
const document = await kit.accountData.export({ actorId, currentPassword })
await kit.accountData.delete({ actorId, currentPassword })
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

Inspection checks that the proof still belongs to the account's current address without consuming
it. Reset and activation completion each consume their proof under the account lock. An activation
link also requires a new password, so claiming an inactive account replaces the earlier password
and invokes the configured credential revocation hook.

### A resend within one minute keeps the same acknowledgement

Repeated activation requests or requests for the same pending email issue one message while
the matching proof remains live within a minute. They return the same success result without
replacing the link; the request throttle still counts each call. A later resend, a changed
pending address, or one after proof expiry rotates the
single-use proof. Requesting the
confirmed address cancels a distinct pending change and deletes its proof; a new pending address
supersedes the previous one. An inactive account changing its address updates both email columns,
sends an activation link, and stays inactive until that link is submitted with a new password.
`inspect` and `inspectEmailChange` are read-only checks for browser navigation; submit the link
through the corresponding completion method after an explicit user action.

`updateProfile` is the profile write surface. It accepts an optional `email` and optional
`registrationData` under current-password proof. The email follows the same pending-address
rules as `requestEmailChange`; only fields returned by `registration.mapFields` may reach the
adapter. Supplying registration data requires `UsersAdapter.updateRegistrationData`, which the
maintained Lucid adapter implements through `mapRegistrationData`. The field write and any
pending-address change share one transaction. Return values are reloaded account records;
application HTTP responses should use an explicit account transformer.

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
`id`, `email`, `unverifiedEmail`, `password`, `emailVerifiedAt`, and `role`. Passwords are set through normal model
save hooks so the application's hashing hook runs once.

Users tables defined with Drizzle or Prisma, or with no ORM, use the shipped
[Drizzle, Prisma and SQL adapters](adapters.md). If using a custom adapter, implement normalized email equality, a unique email constraint, password
hashing, and transaction-aware reads/writes. Provide `resolveMetadata()` with the physical table
and `primaryKey: 'id'`, or configure `usersTable` as the metadata fallback. The package acquires
the PostgreSQL user-row lock centrally from that metadata; SQLite uses its package-owned singleton
transaction lock. See the [`UsersAdapter` type](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/src/types.ts) and the
[adapter contract suite](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/testing/adapter_contract.ts). Review the
[identity creation contract](identity-creation.md) before enabling creation flows.

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

The shared new-password policy applies to registration, reset, invitation acceptance, activation,
and password change. The service ceiling is 256 UTF-16 units. Login still checks an existing
password even when the new-password policy would reject it.

Use `onCredentialsChangedTransaction(user, context, trx)` for token/session revocation that must
commit atomically with a password or email change. The context contains `operation`,
`operationId`, and `userId`. It is mutually exclusive with the legacy
`onCredentialsChanged(user, context)` post-commit callback. The package also invokes the dedicated
`notify.passwordResetCompleted` or `notify.passwordChanged` notice for the corresponding password
operation.

`onLifecycleEvent(event)` receives safe event identifiers after commit. Payloads contain IDs and an
operation ID, not tokens, email addresses, passwords, or notification URLs. Events started by an
operator command also carry `source: 'operator'`; the property is absent otherwise. Treat this callback as
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
[production boundaries](production-boundaries.md#durable-notifications).

## HTTP and error handling

The package does not define application routes, request validators, session policy, or password
requirements. Validate request bodies and path IDs in the application. Map package errors centrally
using their `E_ACCOUNT_KIT_*` code and status metadata; do not expose internal messages or causes.
At the HTTP boundary, map missing and unauthorized invitation-management results to the same
not-found code and response body to avoid revealing the invitation's existence. The exception
classes retain separate codes for application-side diagnosis.

These are service exception defaults. The maintained HTTP reference maps proof failures to 400
with a generic response and retains Vine request validation at 422.

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

See the maintained [API reference](../examples/api/TOKENS.md) and its named controllers for
illustrative route behavior. Adapt it to the application's own transport and error response
conventions.

## Files delta

Configure generates `config/account_kit.ts` and the package migration files. The reset-token
stub is `create_password_reset_tokens.stub` and generates
`*_account_kit_create_password_reset_tokens.ts`, creating `password_reset_tokens`. On upgrade,
the reset-token columns are renamed in place from `user_id` to `tokenable_id` and from
`token_hash` to `hash`, preserving outstanding proofs. Existing application-owned config and
migration files are preserved.
The implementation lives in `src/password_reset.ts`; import the public `AccountKit` and input
types from the package root or its documented type entry point.

## Manual steps

Implement the callbacks for enabled capabilities, adapt application calls and imported input
types, and update lifecycle listeners to `password_reset.requested`. The email-verification event
remains `verification.completed`; all other lifecycle events and `E_ACCOUNT_KIT_*` error codes
also retain their names. An inactive account becomes active when its current email is verified;
the canonical state now uses `email` and `unverifiedEmail`; `emailVerifiedAt` is audit metadata.

Existing installations must also rename their reset-token table in a controlled migration.
Follow the [vocabulary upgrade steps](upgrade.md#vocabulary-alignment) before enabling the new
code. No old service names, exported input aliases, or dual config keys are supplied.

## Changelog

The [Unreleased rename list](../CHANGELOG.md#unreleased) records every breaking public rename.
The forgot password, email-verification, email and password management, and invitation operations
retain their existing responses, defaults, proof semantics and security rules.
