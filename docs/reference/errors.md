# Errors

Every error Account Kit throws extends `AccountKitError`, which extends the AdonisJS `Exception`.
Each carries a stable `code` and an HTTP `status`. Import them from `adonisjs-account-kit` or
`adonisjs-account-kit/errors`.

## Mapping errors to responses

`accountErrorResponse(error, options?)` turns any `AccountKitError` into a safe response and
returns `null` for other errors. Call it from your exception handler:

```ts
import { accountErrorResponse } from 'adonisjs-account-kit'

const mapped = accountErrorResponse(error, { i18n: 'i18n' in ctx ? ctx.i18n : undefined })
if (mapped) {
  for (const [name, value] of Object.entries(mapped.headers)) ctx.response.header(name, value)
  return ctx.response.status(mapped.status).send(mapped.body)
}
```

The body is `{ code, message }`. The message is generic ("Account request rejected" or "Account
operation failed") so that internal causes and callback errors never reach the client. Log the
original error yourself.

- `ThrottledError` adds a `Retry-After` header.
- `PostCommitError` adds `committed: true` to the body.
- `InvitationManagementDeniedError` is reported as `InvitationNotFoundError`, so a caller cannot
  tell a hidden invitation from a missing one.

### Translating the message

When the application uses [`@adonisjs/i18n`](https://docs.adonisjs.com/guides/digging-deeper/i18n),
pass the request's `ctx.i18n` as `i18n`. The message for code `X` is looked up as `errors.X`, with
the English message as the fallback, the same keys the [managed routes](../managed-http.md) use.
The code is the error's own `code` from the catalog below, except that
`E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED` is never returned. These are the keys and their
English messages for `resources/lang/<locale>/errors.json`:

```json
{
  "E_ACCOUNT_KIT": "Account operation failed",
  "E_ACCOUNT_KIT_INVALID_INPUT": "Account request rejected",
  "E_ACCOUNT_KIT_INVALID_TOKEN": "Account request rejected",
  "E_ACCOUNT_KIT_THROTTLED": "Account request rejected",
  "E_ACCOUNT_KIT_AUTHORIZATION": "Account request rejected",
  "E_ACCOUNT_KIT_INVITATION_NOT_FOUND": "Invitation not found",
  "E_ACCOUNT_KIT_SESSION_NOT_FOUND": "Account request rejected",
  "E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED": "Account request rejected",
  "E_ACCOUNT_KIT_NO_PASSWORD": "Account request rejected",
  "E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED": "Account request rejected",
  "E_ACCOUNT_KIT_INVITATION_PENDING": "Account request rejected",
  "E_ACCOUNT_KIT_USER_NOT_FOUND": "Account request rejected",
  "E_ACCOUNT_KIT_DELIVERY": "Account operation failed",
  "E_ACCOUNT_KIT_POST_COMMIT": "Account operation failed",
  "E_ACCOUNT_KIT_CAPABILITY_DISABLED": "Account operation failed",
  "E_INVALID_CREDENTIALS": "Account request rejected",
  "E_ACCOUNT_KIT_INVALID_SESSION": "Account request rejected",
  "E_ACCOUNT_KIT_UNVERIFIED_EMAIL": "Account request rejected",
  "E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID": "Account request rejected",
  "E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED": "Account request rejected",
  "E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING": "Account request rejected",
  "E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND": "Account request rejected",
  "E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID": "Account request rejected",
  "E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD": "Account request rejected"
}
```

An application that also uses the managed routes keeps one `errors.json` for both.

## Catalog

| Error                                     | Code                                           | Status | When                                                                                                                 | What to do                                                                                                     |
| ----------------------------------------- | ---------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `AccountKitError`                         | `E_ACCOUNT_KIT`                                |    500 | Base class for every package error.                                                                                  | Catch it to handle all package errors together.                                                                |
| `InvalidInputError`                       | `E_ACCOUNT_KIT_INVALID_INPUT`                  |    422 | Input fails a package rule, for example a password outside the policy or a malformed email.                          | Validate with VineJS first so users see field errors; treat this as the last line of defense.                  |
| `InvalidTokenError`                       | `E_ACCOUNT_KIT_INVALID_TOKEN`                  |    422 | A proof token is malformed, unknown, used or expired.                                                                | Show "this link is invalid or has expired" and offer to send a new one.                                        |
| `ThrottledError`                          | `E_ACCOUNT_KIT_THROTTLED`                      |    429 | A rate limit is spent. `retryAfterSeconds` says when to retry.                                                       | Return 429 with `Retry-After`. Tune budgets with `throttle` and `invitationThrottle`.                          |
| `AuthorizationError`                      | `E_ACCOUNT_KIT_AUTHORIZATION`                  |    403 | An `authorize` callback denied the action, or public registration is closed.                                         | Check the actor's role in your `authorize` callbacks.                                                          |
| `InvitationManagementDeniedError`         | `E_ACCOUNT_KIT_INVITATION_MANAGEMENT_DENIED`   |    404 | `authorize.manageInvitation` denied a resend or revoke.                                                              | Reported as not found on purpose.                                                                              |
| `InvitationNotFoundError`                 | `E_ACCOUNT_KIT_INVITATION_NOT_FOUND`           |    404 | The invitation does not exist or is no longer pending.                                                               | Refresh the invitation list.                                                                                   |
| `SessionNotFoundError`                    | `E_ACCOUNT_KIT_SESSION_NOT_FOUND`              |    404 | A sign-in to revoke does not exist or belongs to another user.                                                       | Refresh the sign-in list.                                                                                      |
| `IdentityNotConfirmedError`               | `E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED`         |    403 | A password or email change had a wrong or missing current password (or, for a social-only account, no recent proof). | Ask for the current password again.                                                                            |
| `NoPasswordError`                         | `E_ACCOUNT_KIT_NO_PASSWORD`                    |    403 | A password or email change on an account without a local password while social sign-in is disabled.                  | Offer password reset to set a first password.                                                                  |
| `EmailAlreadyRegisteredError`             | `E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED`       |    409 | An email change or invitation targets an address that already has an account.                                        | Ask for a different address.                                                                                   |
| `RegistrationEmailAlreadyRegisteredError` | `E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED`       |    422 | Registration with an address that already has an account. Has `field: 'email'`.                                      | Show it as a field error, or a generic message if you want to hide which addresses exist.                      |
| `InvitationPendingError`                  | `E_ACCOUNT_KIT_INVITATION_PENDING`             |    409 | An invitation to this address is already pending.                                                                    | Resend the existing invitation instead.                                                                        |
| `UserNotFoundError`                       | `E_ACCOUNT_KIT_USER_NOT_FOUND`                 |    404 | `kit.operator.resetLink` (or `account-kit:reset-link`) found no account for the address. Operator paths only.        | Check the address.                                                                                             |
| `DeliveryError`                           | `E_ACCOUNT_KIT_DELIVERY`                       |    500 | A notification callback failed after the account change committed.                                                   | Do not repeat the operation. Check your mail transport; for reset requests, still return the generic response. |
| `PostCommitError`                         | `E_ACCOUNT_KIT_POST_COMMIT`                    |    500 | The database change committed, then a notification or hook failed. Has `committed: true`.                            | Do not repeat the operation. Log it and report success or a partial-success message.                           |
| `CapabilityDisabledError`                 | `E_ACCOUNT_KIT_CAPABILITY_DISABLED`            |    500 | An operation was called for a capability that is not in `enabled`.                                                   | Add the capability to `enabled`, or stop calling it.                                                           |
| `InvalidCredentialsError`                 | `E_INVALID_CREDENTIALS`                        |    400 | Login failed. The same error covers unknown email, wrong password, restricted and passwordless accounts.             | Return one generic message. Many APIs send 401; the example app does.                                          |
| `InvalidSessionError`                     | `E_ACCOUNT_KIT_INVALID_SESSION`                |    401 | The session or token is missing, revoked, or older than the latest credential change.                                | Sign the user out and send them to the login page.                                                             |
| `UnverifiedEmailError`                    | `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`               |    403 | `requireActive` rejected an account that has not confirmed its email address.                                        | Prompt the user to verify, and offer to resend the link.                                                       |
| `SocialTransactionError`                  | `E_ACCOUNT_KIT_SOCIAL_TRANSACTION_INVALID`     |    400 | The social sign-in state is missing, expired or does not match.                                                      | Restart the provider sign-in.                                                                                  |
| `SocialIdentityAlreadyLinkedError`        | `E_ACCOUNT_KIT_SOCIAL_IDENTITY_ALREADY_LINKED` |    409 | The provider account is already linked to a different user.                                                          | Ask the user to sign in with that provider instead.                                                            |
| `SocialEmailMissingError`                 | `E_ACCOUNT_KIT_SOCIAL_EMAIL_MISSING`           |    422 | The provider did not return an email address.                                                                        | Ask the user to make an email visible at the provider, or register with email.                                 |
| `SocialUserNotFoundError`                 | `E_ACCOUNT_KIT_SOCIAL_USER_NOT_FOUND`          |    404 | No account is linked to this provider identity.                                                                      | Offer registration or linking from a signed-in account.                                                        |
| `SocialProofError`                        | `E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID`           |    403 | A sensitive social action lacks a valid recent authentication proof.                                                 | Ask the user to re-enter their password, then retry.                                                           |
| `LastLoginMethodError`                    | `E_ACCOUNT_KIT_SOCIAL_LAST_LOGIN_METHOD`       |    409 | Unlinking would leave the account without any way to sign in.                                                        | Ask the user to set a password or link another provider first.                                                 |

## Stability

Error `code` values are public API from the first public release. This covers the codes in the
catalog above and the managed-route codes in the `errors.json` block in
[managed HTTP](../managed-http.md). A code is changed or removed only as a breaking change listed
in the [changelog](https://github.com/Kevinjohn/oss-adonisjs-account-kit/blob/main/CHANGELOG.md).
Before 1.0 that can happen in a minor release, and it is still listed as breaking.

`message` text can change in any release. Never key on it.

## Translating on the client

SPA and mobile clients that translate on their side should key translations on `code`, not
`message`. The full lists are the catalog above and the `errors.json` block in
[managed HTTP](../managed-http.md). Every package code starts with `E_`.

Request-validation errors come from VineJS and are keyed on the rule and field instead: `rule` and
`field` in JSON, `code` and `source.pointer` in JSON:API. There, `code` is the rule name, such as
`required`, never an `E_` code.

Related: the [security model](../security.md) explains why several of these errors are generic.
