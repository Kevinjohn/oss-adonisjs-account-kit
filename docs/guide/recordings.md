# See it run

Each recording starts with a static preview, including when reduced motion is requested or JavaScript
is disabled. Choose **Show animation** to load its animated version, then **Hide animation** to
remove it and return to the preview.

These recordings cover the selected flows listed below; they do not record every feature or
integration. Each one runs real `curl` and `node ace` commands against a new AdonisJS 7 API app with
managed JSON routes under `/api` and emails printed to the log. Long tokens are shortened and the
`content-type: application/json` header is left out on screen; the real requests send it. Social
sign-in is not recorded because it needs a live provider.

The recordings are regenerated with `pnpm demos` and `pnpm demos:setup`; see
[bin/demos](https://github.com/Kevinjohn/oss-adonisjs-account-kit/tree/main/bin/demos).

## Install check

<AnimatedRecording
  recording="doctor"
  description="account-kit:doctor checking the configuration, limiter, APP_URL and tables in a new app"
/>

More in [getting started](getting-started.md).

## Setup preview and apply

<AnimatedRecording
  recording="setup"
  description="account-kit:setup previewing and applying the API choices and 11-migration inventory"
/>

This recording generates 11 migrations on a separate starter app without the managed routes.
Setup prints a JSON report;
the recording shows its pillars, file changes and next steps one line each.

More in [setup](setup.md).

## Password reset

<AnimatedRecording
  recording="password-reset"
  description="A reset request returns the same response for any address, the log prints the email, the link sets a new password once and fails the second time"
/>

More in [getting started](getting-started.md).

## Signup and email verification

<AnimatedRecording
  recording="signup-verification"
  description="Signup creates an unverified account and emails a verification link; after the link is used, login returns an active account"
/>

More in [registration](registration.md).

## Invitations

<AnimatedRecording
  recording="invitations"
  description="An invitation with a role is sent, the invitee checks the link and sets a password, and a second use of the link fails"
/>

More in [account operations](account-operations.md).

## Email change

<AnimatedRecording
  recording="email-change"
  description="An email change sends a confirmation link to the new address; once it is used the address changes and the old address is told"
/>

More in [account operations](account-operations.md).

## Password change

<AnimatedRecording
  recording="password-change"
  description="A password change on one device signs out the other: its token is rejected with 401"
/>

More in [account operations](account-operations.md).

## Login throttling

<AnimatedRecording
  recording="login-throttling"
  description="Five wrong passwords get one generic error, then the address is blocked with 429 even for the right password"
/>

More in [authentication](authentication.md).

## Magic-link sign-in

<AnimatedRecording
  recording="magic-link"
  description="A magic link opened without the right verifier fails and is used up; a new link completes in the app that asked for it"
/>

More in [magic-link sign-in](magic-link.md).

## Signed-in devices

<AnimatedRecording
  recording="devices"
  description="Listing signed-in devices, then signing out every other device"
/>

More in [signed-in devices](signed-in-devices.md).

## Account export and deletion

<AnimatedRecording
  recording="export-deletion"
  description="Exporting account data after re-entering the password, then deleting the account; login fails afterwards"
/>

More in [account export and deletion](account-data.md).

## Operator commands

<AnimatedRecording
  recording="operator-commands"
  description="account-kit:reset-link sending a reset email from the shell, and account-kit:prune deleting expired rows"
/>

More in [operations](operations.md).
