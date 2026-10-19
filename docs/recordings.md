# See it run

Each recording runs real `curl` and `node ace` commands against a new AdonisJS 7 API app with
the managed JSON routes under `/api` and emails printed to the log. Long tokens are shortened and the
`content-type: application/json` header is left out on screen; the real requests send it. Social sign-in is not recorded, because it needs a live provider.

The recordings are regenerated with `pnpm demos` and `pnpm demos:setup`; see
[scripts/demos](https://github.com/Kevinjohn/oss-adonisjs-account-kit/tree/main/scripts/demos).

## Install check

![account-kit:doctor checking the configuration, limiter, APP_URL and tables in a new app](assets/demos/doctor.svg)

More in [getting started](getting-started.md).

## Setup preview and apply

![account-kit:setup previewing the API choices file without writing, then applying it: config, guard adapter, middleware, inert route mount and 13 migrations](assets/demos/setup.svg)

This one runs on a separate starter app without the managed routes. Setup prints a JSON report; the recording shows its pillars, file changes and next steps one line each.

More in [setup](setup.md).

## Password reset

![A reset request returns the same response for any address, the log prints the email, the link sets a new password once and fails the second time](assets/demos/password-reset.svg)

More in [getting started](getting-started.md).

## Signup and email verification

![Signup creates an unverified account and emails a verification link; after the link is used, login returns an active account](assets/demos/signup-verification.svg)

More in [registration](registration.md).

## Invitations

![An invitation with a role is sent, the invitee checks the link and sets a password, and a second use of the link fails](assets/demos/invitations.svg)

More in [account operations](account-operations.md).

## Email change

![An email change sends a confirmation link to the new address; once it is used the address changes and the old address is told](assets/demos/email-change.svg)

More in [account operations](account-operations.md).

## Password change

![A password change on one device signs out the other: its token is rejected with 401](assets/demos/password-change.svg)

More in [account operations](account-operations.md).

## Login throttling

![Five wrong passwords get one generic error, then the address is blocked with 429 even for the right password](assets/demos/login-throttling.svg)

More in [authentication](authentication.md).

## Magic-link sign-in

![A magic link opened without the right verifier fails and is used up; a new link completes in the app that asked for it](assets/demos/magic-link.svg)

More in [magic-link sign-in](magic-link.md).

## Signed-in devices

![Listing signed-in devices, then signing out every other device](assets/demos/devices.svg)

More in [signed-in devices](signed-in-devices.md).

## Account export and deletion

![Exporting account data after re-entering the password, then deleting the account; login fails afterwards](assets/demos/export-deletion.svg)

More in [account export and deletion](account-data.md).

## Operator commands

![account-kit:reset-link sending a reset email from the shell, and account-kit:prune deleting expired rows](assets/demos/operator-commands.svg)

More in [operations](operations.md).
