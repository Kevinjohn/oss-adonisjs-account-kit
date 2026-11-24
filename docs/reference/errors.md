# Errors

Package-defined account errors extend `E_ACCOUNT_KIT`, which extends the AdonisJS `Exception`.
Each exception carries a stable `code` and HTTP `status`. Catch the constructors through
`errors.E_*` from the root export or use a named import from `/errors`. Database errors and errors thrown by application
callbacks may propagate as their original error; callback failures after commit are wrapped in one
of the committed failure types below. Import package errors from `@kevinjohn/adonisjs-account-kit` or
`@kevinjohn/adonisjs-account-kit/errors`.

## Mapping errors to responses

`accountErrorResponse(error, options?)` turns an `E_ACCOUNT_KIT` into a safe response and returns
`null` for an unknown error. Call it from your exception handler after operation-specific committed
failure handling:

```ts
import { accountErrorResponse } from '@kevinjohn/adonisjs-account-kit'

const mapped = accountErrorResponse(error, {
  i18n: 'i18n' in ctx ? ctx.i18n : undefined,
  accept: ctx.request.header('accept'),
})
if (mapped) {
  for (const [name, value] of Object.entries(mapped.headers)) {
    if (name === 'Vary') ctx.response.vary(value)
    else ctx.response.header(name, value)
  }
  ctx.response.header('Content-Type', mapped.contentType)
  return ctx.response.status(mapped.status).send(mapped.body)
}
```

The helper runs the same mapper as the managed routes, so the status, code, body, headers and
content type match theirs for the same error. Its options are:

- `i18n`: the request's `ctx.i18n`, to translate the message (see below).
- `accept`: the request's `Accept` header, negotiated as AdonisJS does. When the client prefers
  `application/vnd.api+json` to JSON (higher quality, or equal quality and listed first), `contentType` is `application/vnd.api+json` and the entry carries
  `title` instead of `message`. Otherwise `contentType` is `application/json`.
- `proof`: `'password'`, `'email'`, `'invitation'` or `'magicLink'`. An `E_ACCOUNT_KIT_INVALID_TOKEN` then
  returns the per-kind code, such as `E_ACCOUNT_KIT_INVALID_PASSWORD_TOKEN`, instead of
  `E_ACCOUNT_KIT_INVALID_TOKEN`.

With no options object, the body is `{ errors: [{ code, message }] }` and `contentType` is the literal
`application/json`. Passing an options object keeps the negotiated entry type: JSON has `message`,
while JSON:API has `title`. Narrow entries from those calls before reading either property, for
example with `'message' in entry`. Both forms use the same envelope the managed routes send. A plain
JSON entry adds `field` when the error names one:
`E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED` returns 422 with `field: 'email'`. A masked or 5xx error
never carries `field`. The headers include `Vary: Accept`; append it with `ctx.response.vary` so an
existing `Vary` value is kept. The entry
adds `committed: true` for `E_ACCOUNT_KIT_POST_COMMIT`; `E_ACCOUNT_KIT_DELIVERY` is a committed delivery-only failure
without that marker. Every 5xx error returns `E_ACCOUNT_KIT_OPERATION_FAILED`. `E_ACCOUNT_KIT.handle`
renders the same masked envelope when a package error reaches the AdonisJS exception handler from
your own routes, and that handler reports 5xx errors to the application log. Managed routes log a
masked 5xx error with the route name through the request logger; when you call
`accountErrorResponse`, log the error yourself. `E_ACCOUNT_KIT_POST_COMMIT` identifies a failed observer
or commit listener; if a delivery also fails, its cause is included.
For mutating operations, both errors mean the change committed, so map them at the operation boundary
to its ordinary success or partial-success response. Read-only account inspection is
different: an `E_ACCOUNT_KIT_POST_COMMIT` discards its snapshot, so no successful result is available. Retry
inspection only with adapters and policy callbacks that satisfy its read-only, retry-safe contract. Log a redacted failure
kind and operation name; keep causes and raw unknown errors in private application reporting.

For a copyable reset-request boundary, validate with Vine first so field errors follow AdonisJS's
normal response, then preserve the generic acknowledgement for either committed failure:

```ts
import { E_ACCOUNT_KIT_DELIVERY, isCommittedFailure } from '@kevinjohn/adonisjs-account-kit/errors'

const acknowledgement = { message: 'If the account exists, instructions will be sent.' }
try {
  await accountKit.passwordReset.request({ email, clientKey: request.ip() })
} catch (error) {
  if (isCommittedFailure(error)) {
    logger.error(
      {
        operation: 'password_reset.request',
        failure: error instanceof E_ACCOUNT_KIT_DELIVERY ? 'delivery' : 'post_commit',
      },
      'Password reset request committed but follow-up failed'
    )
    return response.accepted(acknowledgement)
  }

  const mapped = accountErrorResponse(error, {
    i18n: 'i18n' in ctx ? ctx.i18n : undefined,
    accept: request.header('accept'),
  })
  if (mapped) {
    for (const [name, value] of Object.entries(mapped.headers)) {
      if (name === 'Vary') response.vary(value)
      else response.header(name, value)
    }
    response.header('Content-Type', mapped.contentType)
    return response.status(mapped.status).send(mapped.body)
  }
  throw error
}
return response.accepted(acknowledgement)
```

For reset **completion**, report committed follow-up failure as a successful password change rather
than inviting another reset. A notice-only failure is `E_ACCOUNT_KIT_DELIVERY`; if an observer or commit
listener also fails, the operation throws `E_ACCOUNT_KIT_POST_COMMIT` with both causes. The example outbox persists password-reset
**completion** and password-change notices, but not reset-link delivery. A failed reset-link
delivery keeps the generic acknowledgement, and the requester can submit another generic reset
request for a replacement link. For signup, direct the person to request another verification link;
for a pending invitation, resend it. If invitation acceptance committed, direct the new account to
sign in or use password reset. Check the committed account or invitation state before choosing the
next action, and never repeat signup or invitation acceptance. The [starter tutorial](../guide/getting-started.md)
shows reset request and completion handling. Never log full proof-bearing URLs, raw bearer
credentials, or callback causes in the response.

- `E_ACCOUNT_KIT_THROTTLED` adds a `Retry-After` header. Every package error response sets
  `Cache-Control: no-store` and `Vary: Accept`.
- `E_ACCOUNT_KIT_DELIVERY` marks a committed delivery-path failure. It returns
  `E_ACCOUNT_KIT_OPERATION_FAILED` without a `committed` marker.
- `E_ACCOUNT_KIT_POST_COMMIT` marks a failed post-commit observer or commit listener and adds `committed: true` to
  the mapped body. If delivery also fails in the same follow-up batch, its cause is included.
- `E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED` is reported as `E_ACCOUNT_KIT_INVITATION_NOT_FOUND`, so a caller cannot
  tell a hidden invitation from a missing one.

### Translating the message

When the application uses [`@adonisjs/i18n`](https://docs.adonisjs.com/guides/digging-deeper/i18n),
pass the request's `ctx.i18n` as `i18n`. The message for code `X` is looked up as `errors.X`, with
the English message as the fallback, the same keys the [managed routes](../guide/managed-http.md) use.
The key is the public `code` the response carries. That is the error's own code, except that every
5xx returns `E_ACCOUNT_KIT_OPERATION_FAILED`, `E_ACCOUNT_KIT_AUTHORIZATION` returns `E_ACCOUNT_KIT_FORBIDDEN`,
and `E_ACCOUNT_KIT_INVALID_SESSION` returns `E_INVALID_CREDENTIALS`. These are the keys and their English
messages for `resources/lang/<locale>/errors.json`:

```json
{
  "E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED": "Account request rejected.",
  "E_ACCOUNT_KIT_OPERATION_FAILED": "Account operation failed.",
  "E_ACCOUNT_KIT_FORBIDDEN": "Access denied.",
  "E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED": "The account request conflicts with an existing account.",
  "E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED": "Current identity proof could not be confirmed.",
  "E_INVALID_CREDENTIALS": "Authentication failed.",
  "E_ACCOUNT_KIT_INVALID_INPUT": "Account request rejected.",
  "E_ACCOUNT_KIT_ADMISSION_REQUIRED": "Account request rejected.",
  "E_ACCOUNT_KIT_ADMISSION_DECISION": "Account request rejected.",
  "E_ACCOUNT_KIT_INVALID_TOKEN": "This link is invalid or expired.",
  "E_ACCOUNT_KIT_INVITATION_NOT_FOUND": "Invitation not found.",
  "E_ACCOUNT_KIT_INVITATION_PENDING": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD": "Account request rejected.",
  "E_ACCOUNT_KIT_NO_PASSWORD": "Account request rejected.",
  "E_ACCOUNT_KIT_SESSION_NOT_FOUND": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID": "Account request rejected.",
  "E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND": "Account request rejected.",
  "E_ACCOUNT_KIT_THROTTLED": "Too many requests.",
  "E_ACCOUNT_KIT_UNVERIFIED_EMAIL": "Email verification is required.",
  "E_ACCOUNT_KIT_USER_NOT_FOUND": "Account request rejected."
}
```

With `proof`, an `E_ACCOUNT_KIT_INVALID_TOKEN` uses its per-kind code instead, so add those keys too; the
[managed routes guide](../guide/managed-http.md) lists them. An application that also uses the
managed routes keeps one `errors.json` for both.

## Catalogue {#catalog}

| Error                                                 | Code                                           | Status | When                                                                                                                                                         | What to do                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E_ACCOUNT_KIT`                                       | `E_ACCOUNT_KIT`                                |    500 | Base class for package-defined account errors. Raw database and application callback errors may propagate unchanged.                                         | Catch it to handle package errors together; let unknown errors reach normal application reporting.                                                                         |
| `E_ACCOUNT_KIT_INVALID_CONFIGURATION`                 | `E_ACCOUNT_KIT_INVALID_CONFIGURATION`          |    500 | Thrown by configuration and admission validation, including static adapter definitions.                                                                      | Check `field` for the invalid configuration path.                                                                                                                          |
| `E_ACCOUNT_KIT_ADAPTER_CONTRACT`                      | `E_ACCOUNT_KIT_ADAPTER_CONTRACT`               |    500 | `canAccess` resolved to a non-boolean, or the token guard gave a managed route no token, identifier or bearer value.                                         | Fix the callback or guard. Clients get `E_ACCOUNT_KIT_OPERATION_FAILED`. Managed routes and the AdonisJS exception handler log it; `accountErrorResponse` callers must.    |
| `E_ACCOUNT_KIT_INVALID_INPUT`                         | `E_ACCOUNT_KIT_INVALID_INPUT`                  |    422 | Input fails a package rule, for example a password outside the policy or a malformed email.                                                                  | Validate with VineJS first so users see field errors; treat this as the last line of defence.                                                                              |
| `E_ACCOUNT_KIT_INVALID_TOKEN`                         | `E_ACCOUNT_KIT_INVALID_TOKEN`                  |    400 | A proof token is malformed, unknown, used or expired.                                                                                                        | Show "this link is invalid or has expired" and offer to send a new one.                                                                                                    |
| `E_ACCOUNT_KIT_THROTTLED`                             | `E_ACCOUNT_KIT_THROTTLED`                      |    429 | A rate limit is spent. `retryAfterSeconds` says when to retry.                                                                                               | Return 429 with `Retry-After`. Tune budgets with `throttle` and `invitationThrottle`.                                                                                      |
| `E_ACCOUNT_KIT_AUTHORIZATION`                         | `E_ACCOUNT_KIT_AUTHORIZATION`                  |    403 | An `authorize` callback denied the action, or public registration is closed.                                                                                 | Check the actor's role in your `authorize` callbacks, or the `registration.availability` setting.                                                                          |
| `E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED`          | `E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED`   |    404 | `authorize.manageInvitation` denied a resend or revoke.                                                                                                      | Reported as not found on purpose.                                                                                                                                          |
| `E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED`                 | `E_ACCOUNT_KIT_ACCOUNT_ACCESS_DENIED`          |    403 | Account inspection found the account missing, restricted, or inactive when `requireActive` was true. Returned by `authentication.inspectAccountAccess` only. | Treat all three causes alike; the error carries no reason on purpose.                                                                                                      |
| `E_ACCOUNT_KIT_INVITATION_NOT_FOUND`                  | `E_ACCOUNT_KIT_INVITATION_NOT_FOUND`           |    404 | The invitation does not exist or is no longer pending.                                                                                                       | Refresh the invitation list.                                                                                                                                               |
| `E_ACCOUNT_KIT_SESSION_NOT_FOUND`                     | `E_ACCOUNT_KIT_SESSION_NOT_FOUND`              |    404 | A sign-in to revoke does not exist or belongs to another user.                                                                                               | Refresh the sign-in list.                                                                                                                                                  |
| `E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED`                | `E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED`         |    403 | A password or email change had a wrong or missing current password (or, for a social-only account, no recent proof).                                         | Ask for the current password again.                                                                                                                                        |
| `E_ACCOUNT_KIT_NO_PASSWORD`                           | `E_ACCOUNT_KIT_NO_PASSWORD`                    |    403 | A password or email change on an account without a local password while social sign-in is disabled.                                                          | Offer password reset to set a first password.                                                                                                                              |
| `E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED`              | `E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED`       |    409 | An email change or invitation targets an address that already has an account.                                                                                | Ask for a different address.                                                                                                                                               |
| `E_ACCOUNT_KIT_REGISTRATION_EMAIL_ALREADY_REGISTERED` | `E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED`       |    422 | Registration with an address that already has an account. Has `field: 'email'`.                                                                              | Show it as a field error, or a generic message if you want to hide which addresses exist.                                                                                  |
| `E_ACCOUNT_KIT_INVITATION_PENDING`                    | `E_ACCOUNT_KIT_INVITATION_PENDING`             |    409 | An invitation to this address is already pending.                                                                                                            | Resend the existing invitation instead.                                                                                                                                    |
| `E_ACCOUNT_KIT_USER_NOT_FOUND`                        | `E_ACCOUNT_KIT_USER_NOT_FOUND`                 |    404 | `kit.operator.resetLink` (or `account-kit:reset-link`) found no account for the address. Operator paths only.                                                | Check the address.                                                                                                                                                         |
| `E_ACCOUNT_KIT_DELIVERY`                              | `E_ACCOUNT_KIT_DELIVERY`                       |    500 | A committed delivery-path failure. Does not carry `committed: true`.                                                                                         | Do not repeat the operation. Report its committed outcome and inspect only persisted notices.                                                                              |
| `E_ACCOUNT_KIT_POST_COMMIT`                           | `E_ACCOUNT_KIT_POST_COMMIT`                    |    500 | A post-commit observer or commit listener failed; the cause can include delivery failures from the same follow-up batch. Has the marker.                     | Do not repeat a committed mutation; log a redacted failure and report its committed outcome. Read-only inspection may be retried under its documented dependency contract. |
| `E_ACCOUNT_KIT_CAPABILITY_DISABLED`                   | `E_ACCOUNT_KIT_CAPABILITY_DISABLED`            |    500 | An operation was called for a capability that is not in `enabled`.                                                                                           | Add the capability to `enabled`, or stop calling it.                                                                                                                       |
| `E_INVALID_CREDENTIALS`                               | `E_INVALID_CREDENTIALS`                        |    401 | Login failed. The same error covers unknown email, wrong password, restricted and passwordless accounts.                                                     | Return one generic message. Official `@adonisjs/auth` sends 400; this package sends 401.                                                                                   |
| `E_ACCOUNT_KIT_INVALID_SESSION`                       | `E_ACCOUNT_KIT_INVALID_SESSION`                |    401 | The session or token is missing, revoked, or older than the latest credential change.                                                                        | Sign the user out and send them to the login page.                                                                                                                         |
| `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`                      | `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`               |    403 | `requireActive` rejected an account that has not confirmed its email address.                                                                                | Prompt the user to verify, and offer to resend the link.                                                                                                                   |
| `E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID`            | `E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID`     |    400 | The social sign-in state is missing, expired or does not match.                                                                                              | Restart the provider sign-in.                                                                                                                                              |
| `E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED`        | `E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED` |    409 | The provider account is already linked to a different user.                                                                                                  | Ask the user to sign in with that provider instead.                                                                                                                        |
| `E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING`                  | `E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING`           |    422 | The provider did not return an email address.                                                                                                                | Ask the user to make an email visible at the provider, or register with email.                                                                                             |
| `E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND`                 | `E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND`          |    404 | No account is linked to this provider identity.                                                                                                              | Offer registration or linking from a signed-in account.                                                                                                                    |
| `E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID`                  | `E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID`           |    403 | A sensitive social action lacks a valid recent authentication proof.                                                                                         | Ask the user to re-enter their password, then retry.                                                                                                                       |
| `E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED`                   | `E_ACCOUNT_KIT_SOCIAL_LINK_REFUSED`            |    403 | `socialAuthentication.acceptLink` refused to link this provider account.                                                                                     | Explain the application rule the provider account must meet.                                                                                                               |
| `E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD`              | `E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD`       |    409 | Unlinking would leave the account without any way to sign in.                                                                                                | Ask the user to set a password or link another provider first.                                                                                                             |

## Admission errors

The optional [admission module](../guide/admission.md) adds two errors. They extend `E_ACCOUNT_KIT`,
so `accountErrorResponse` maps them, but they are exported only from
`@kevinjohn/adonisjs-account-kit/admission`:

```ts
import {
  E_ACCOUNT_KIT_ADMISSION_DECISION,
  E_ACCOUNT_KIT_ADMISSION_REQUIRED,
} from '@kevinjohn/adonisjs-account-kit/admission'
```

| Error                              | Code                               | Status | When                                                                         | What to do                                                                                     |
| ---------------------------------- | ---------------------------------- | -----: | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `E_ACCOUNT_KIT_ADMISSION_REQUIRED` | `E_ACCOUNT_KIT_ADMISSION_REQUIRED` |    403 | The admission gate refused a person who is not admitted. Carries `decision`. | Add `decision` to the body and show what is missing; keep the admission status page reachable. |
| `E_ACCOUNT_KIT_ADMISSION_DECISION` | `E_ACCOUNT_KIT_ADMISSION_DECISION` |    409 | An approve, reject or revoke that the current approval state does not allow. | Reload the admission list and show the current state.                                          |

Their translation keys are `errors.E_ACCOUNT_KIT_ADMISSION_REQUIRED` and
`errors.E_ACCOUNT_KIT_ADMISSION_DECISION`, with the English message `Account request rejected.`.

## Stability

Error `code` values are public API from the first public release. This covers the codes in the
catalogue above and the managed-route codes in the `errors.json` block in
[managed HTTP](../guide/managed-http.md). A code is changed or removed only as a breaking change listed
in the [changelog](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/CHANGELOG.md).
Before 1.0 that can happen in a minor release, and it is still listed as breaking.

`message` text can change in any release. Never key on it.

## Translating on the client

SPA and mobile clients that translate on their side should key translations on `code`, not
`message`. The full lists are the catalogue above and the `errors.json` block in
[managed HTTP](../guide/managed-http.md). Every package code starts with `E_`.

Request-validation errors come from VineJS and are keyed on the rule and field instead: `rule` and
`field` in JSON, `code` and `source.pointer` in JSON:API. There, `code` is the rule name, such as
`required`, never an `E_` code.

Related: the [security model](../guide/security.md) explains why several of these errors are generic.

### Setup and operator diagnostics

These constructors are available through the same imports. Their original messages and causes are
for operators. See [setup guidance](../guide/setup.md) for recovery.

| Constructor                                         | Code                                                | Status | Cause                                                                                             |
| --------------------------------------------------- | --------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| `E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION` | `E_ACCOUNT_KIT_UNSUPPORTED_PROVIDERS_CONFIGURATION` | 500    | The application's provider configuration cannot be inspected safely.                              |
| `E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE`            | `E_ACCOUNT_KIT_UNSUPPORTED_CONFIG_SHAPE`            | 500    | The application configuration is not statically inspectable.                                      |
| `E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG`              | `E_ACCOUNT_KIT_INVALID_PROVIDERS_FLAG`              | 500    | The retirement command received an unsupported or repeated provider.                              |
| `E_ACCOUNT_KIT_MIGRATION_DIRECTORY`                 | `E_ACCOUNT_KIT_MIGRATION_DIRECTORY`                 | 500    | Setup cannot use the selected migration directory.                                                |
| `E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED`             | `E_ACCOUNT_KIT_SETUP_APPLY_INTERRUPTED`             | 500    | Setup failed after publishing some files. The exception carries the written paths.                |
| `E_ACCOUNT_KIT_INVALID_SETUP_SOURCE`                | `E_ACCOUNT_KIT_INVALID_SETUP_SOURCE`                | 500    | Setup cannot inspect invalid TypeScript.                                                          |
| `E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE`          | `E_ACCOUNT_KIT_SELECTED_ENVIRONMENT_VALUE`          | 500    | A selected environment value cannot be read safely.                                               |
| `E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE`          | `E_ACCOUNT_KIT_INDIRECT_ENVIRONMENT_VALUE`          | 500    | Reading a selected environment value would require evaluation.                                    |
| `E_ACCOUNT_KIT_BOOTSTRAP_APPROVAL_CHANGED`          | `E_ACCOUNT_KIT_INVALID_INPUT`                       | 422    | The invitation committed and its waiting approval was replaced or cancelled. Run bootstrap again. |
