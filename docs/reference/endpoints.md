# Managed endpoints

`registerManagedRoutes` from `adonisjs-account-kit/http` mounts these JSON routes under the
`prefix` you choose, for example `/api/v1`. Only the capabilities in its `enabled` list are
mounted, and `except` removes individual endpoints by name. Setup and guard requirements are in
[managed HTTP](../managed-http.md).

Access levels:

- **public**: no credential required. Proof routes take the token from the link.
- **limited**: signed in with the configured guard. Accounts that have not verified their email are
  allowed, so they can fix a mistyped address or resend the link.
- **active**: signed in and verified. Set `verificationRequired: false` to allow unverified
  accounts here too.

`auth/csrf` is mounted for the `session` strategy whenever any capability is enabled.

## `registration`

| Method | Path           | Name          | Access |
| ------ | -------------- | ------------- | ------ |
| `POST` | `/auth/signup` | `auth.signup` | public |

## `authentication`

| Method | Path               | Name                   | Access  |
| ------ | ------------------ | ---------------------- | ------- |
| `GET`  | `/auth/csrf`       | `auth.csrf`            | public  |
| `POST` | `/auth/login`      | `auth.login`           | public  |
| `POST` | `/account/logout`  | `account.logout`       | limited |
| `GET`  | `/account/profile` | `account.profile.show` | limited |

## `passwordReset`

| Method | Path                          | Name                          | Access |
| ------ | ----------------------------- | ----------------------------- | ------ |
| `POST` | `/auth/password-reset`        | `auth.passwordReset.request`  | public |
| `GET`  | `/auth/password-reset/:token` | `auth.passwordReset.inspect`  | public |
| `POST` | `/auth/password-reset/:token` | `auth.passwordReset.complete` | public |

## `emailVerification`

| Method | Path                               | Name                              | Access  |
| ------ | ---------------------------------- | --------------------------------- | ------- |
| `GET`  | `/auth/email-verification/:token`  | `auth.emailVerification.inspect`  | public  |
| `POST` | `/auth/email-verification/:token`  | `auth.emailVerification.complete` | public  |
| `POST` | `/account/email-verification/send` | `account.emailVerification.send`  | limited |

## `invitations`

| Method   | Path                              | Name                        | Access |
| -------- | --------------------------------- | --------------------------- | ------ |
| `GET`    | `/auth/invitations/:token`        | `auth.invitation.inspect`   | public |
| `POST`   | `/auth/invitations/:token`        | `auth.invitation.accept`    | public |
| `POST`   | `/account/invitations`            | `account.invitation.send`   | active |
| `GET`    | `/account/invitations`            | `account.invitation.list`   | active |
| `POST`   | `/account/invitations/:id/resend` | `account.invitation.resend` | active |
| `DELETE` | `/account/invitations/:id`        | `account.invitation.revoke` | active |

## `emailPasswordManagement`

| Method  | Path                        | Name                        | Access  |
| ------- | --------------------------- | --------------------------- | ------- |
| `GET`   | `/auth/email-change/:token` | `auth.emailChange.inspect`  | public  |
| `POST`  | `/auth/email-change/:token` | `auth.emailChange.complete` | public  |
| `PATCH` | `/account/profile`          | `account.profile.update`    | limited |
| `POST`  | `/account/password`         | `account.password.change`   | active  |

## `socialAuthentication`

| Method   | Path                                 | Name                              | Access  |
| -------- | ------------------------------------ | --------------------------------- | ------- |
| `POST`   | `/auth/oauth/:provider/redirect`     | `auth.oauth.redirect`             | public  |
| `GET`    | `/auth/oauth/:provider/callback`     | `auth.oauth.callback`             | public  |
| `POST`   | `/auth/oauth/:provider/callback`     | `auth.oauth.complete`             | public  |
| `POST`   | `/auth/oauth/registration`           | `auth.oauth.registration`         | public  |
| `POST`   | `/auth/oauth/:provider/confirmation` | `auth.oauth.confirmation`         | public  |
| `POST`   | `/auth/oauth/token`                  | `auth.oauth.token`                | public  |
| `GET`    | `/auth/methods`                      | `auth.methods`                    | public  |
| `POST`   | `/account/social-proof/password`     | `account.socialProof.password`    | limited |
| `GET`    | `/account/social-identities`         | `account.socialIdentities.list`   | limited |
| `DELETE` | `/account/social-identities/:id`     | `account.socialIdentities.unlink` | limited |
