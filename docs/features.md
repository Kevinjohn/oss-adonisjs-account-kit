# Features

Account Kit provides common account flows and additional capabilities. Additional flows are
opt-in; their guides describe the setup each one needs. Commands, OpenAPI generation, and user
adapters are integration tools, not additional account flows to enable.

## Core features

### Forgot password

- Single-use reset links that expire. Only a SHA-256 hash of each token is stored.
- The same response, after the same minimum delay, for known and unknown addresses, so the form
  cannot be used to find out who has an account.
- A completed reset signs out every older session and access token, then emails the user.

Guide: [getting started](getting-started.md).

### Email verification and signup

- Signup open to anyone, closed, or behind your own signup rule.
- Confirmation links, with a rate-limited resend.
- New accounts stay inactive until the address is confirmed.

Guide: [registration](registration.md).

### Login

- Sessions or access tokens, through the Auth guard you already have.
- One generic error for every failed login, with rate limits per client and per identity.
- Changing a password or email signs out older sessions and tokens. A password change can keep
  the session or token that made it; the managed route does.

Guides: [sessions](recipes/sessions.md), [access tokens](recipes/access-tokens.md).

### Account settings

- Change password, with the current password required.
- Change email: the new address is confirmed before it replaces the old one, and the old address
  is told about the change.
- Update profile fields.

Reference: [account operations](account-operations.md).

### Invitations

- Invite by email with a role. Resend, revoke and list invitations a page at a time.
- Your own callback decides who may invite whom.

Reference: [usage](usage.md).

### Included with every flow

- **Emails** for AdonisJS Mail, with English templates you can translate with `@adonisjs/i18n`,
  or your own templates. See [notifications](notifications.md).
- **Rate limits** through `@adonisjs/limiter`. Limiter keys are HMAC digests, so the store never
  holds an email address or IP. See [production requirements](reference/production-requirements.md#limiter-secret-and-budgets).
- **Your routes or ours.** Call the service from your own controllers, or mount the
  [managed JSON routes](managed-http.md).
- **Ace commands**: `account-kit:setup` for guided setup, `account-kit:doctor` to check the
  configuration, and `account-kit:prune` to delete expired tokens.
- **Test helpers** that capture emails and pull the token out of them. See
  [testing](recipes/testing.md).

## Additional features

### Magic-link sign-in

Users sign in from a link sent to their email address, with no password.

- The link works once and expires after 15 minutes by default.
- It only works in the browser or app that asked for it, so a forwarded or leaked link is useless.
- Mail scanners that open links do not use them up.

Turn on: `enabled: [..., 'magicLinkLogin']`. Guide: [magic-link sign-in](magic-link.md).

### Signed-in devices and sign out everywhere

Users see where they are signed in and end sessions they do not recognize.

- List sign-ins, with a label, when each started and when it was last used.
- Sign out one device, every other device, or everywhere.
- Session sign-ins expire after 30 days without use by default.

Turn on: `enabled: [..., 'sessionManagement']`. Guide: [signed-in devices](signed-in-devices.md).

### Account export and deletion

Helpers for exporting account data and closing an account.

- Export: a JSON download of package-held account data merged with data your application supplies.
- Deletion: removes the user and Account Kit-owned rows, with a hook for your application to delete
  or anonymise its own rows in the same transaction, and a confirmation email.
- Both require the user to re-enter their password or prove a recent sign-in.

These helpers do not determine which data your application must export, retain, or delete under
applicable requirements.

Turn on: `enabled: [..., 'dataExport', 'accountDeletion']`. Guide:
[account export and deletion](account-data.md).

### Admission

Keep signed-in accounts out of your application data until they are admitted.

- Require any mix of an allowed email domain, an accepted invitation and an approver's decision.
- People who are not admitted can still sign in, see why, and ask for approval.
- Your callbacks decide who may approve; Account Kit stores the state and checks it on every
  gated request.

Install: `node ace account-kit:admission:install`. Guide: [admission](admission.md).

### Google and GitHub sign-in

- Sign-in and account linking through AdonisJS Ally.
- New accounts from a provider follow your signup policy.

Guide: [social sign-in](recipes/social-login.md).

### Operator commands

Act on accounts from the shell, for example to create the first administrator or help a user who
is locked out.

```sh
node ace account-kit:invite admin@example.com --role=admin
node ace account-kit:reset-link person@example.com
```

The link is emailed by default; `--print` prints it to the terminal instead. Reference:
[operator commands](operations.md#operator-commands).

### OpenAPI document

`node ace account-kit:openapi` writes an OpenAPI 3.1 document for exactly the managed routes you
mounted. Use it for client generators, API reference pages and contract tests. Guide:
[OpenAPI document](openapi.md).

### Drizzle, Prisma and plain SQL users

Users do not have to be a Lucid model. Adapters for Drizzle, Prisma and plain SQL ship with the
package, and a contract test suite checks any adapter you write yourself. Guide:
[users adapters](adapters.md).

### Databases

Tested on SQLite, PostgreSQL 16 and MySQL 8.4. See the [database compatibility matrix](compatibility.md)
for the supported versions and verification notes.

## Features at a glance

| Operation               | Service API                                  | Managed route (after configured prefix) | Email sent                                  | Rate limit                    |
| ----------------------- | -------------------------------------------- | --------------------------------------- | ------------------------------------------- | ----------------------------- |
| Request password reset  | `passwordReset.request`                      | `POST auth/password-reset`              | `passwordResetProvision`                    | Per client and per address    |
| Complete password reset | `passwordReset.reset`                        | `POST auth/password-reset/:token`       | `passwordResetCompleted`                    | Per client (managed route)    |
| Sign up                 | `registration.register`                      | `POST auth/signup`                      | `accountActivationProvision`                | Per client (managed route)    |
| Resend verification     | `emailVerification.send`                     | `POST account/email-verification/send`  | `accountActivationProvision`                | Per user                      |
| Confirm email           | `emailVerification.complete`                 | `POST auth/email-verification/:token`   | none                                        | Per client (managed route)    |
| Log in                  | `authentication.login`                       | `POST auth/login`                       | none                                        | Per client and per identity   |
| Request sign-in link    | `magicLink.request`                          | `POST auth/magic-link`                  | `magicLinkProvision`                        | Per client and per address    |
| Sign in by link         | `magicLink.complete`                         | `POST auth/magic-link/:token`           | none                                        | Per client (managed route)    |
| Change password         | `emailPasswordManagement.changePassword`     | `POST account/password`                 | `passwordChanged`                           | Per user                      |
| Change email            | `emailPasswordManagement.requestEmailChange` | `PATCH account/profile`                 | `emailChangeProvision`, then `emailChanged` | Per user                      |
| Invite                  | `invitations.send`                           | `POST account/invitations`              | `invitationProvision`                       | Per inviter and per recipient |
| Accept invitation       | `invitations.accept`                         | `POST auth/invitations/:token`          | none                                        | Per client (managed route)    |
| Export account data     | `accountData.export`                         | `POST account/export`                   | none                                        | Per user                      |
| Delete account          | `accountData.delete`                         | `DELETE account`                        | `accountDeleted`                            | Per user                      |

The managed-route paths are relative to the prefix configured with `registerManagedRoutes`. For
example, with `prefix: '/api/v1'`, `POST auth/password-reset` is `POST /api/v1/auth/password-reset`.
The `account-kit:prune` command and public `PruneCounts` result retain the legacy key `recovery`
for expired password-reset tokens. The full route lists are in [usage](usage.md) and the
[endpoint reference](reference/endpoints.md).
