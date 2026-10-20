# Account operations

## Configuration

Enable the required capabilities from `passwordReset`, `emailVerification`,
`emailPasswordManagement`, and `invitations`. Configure the corresponding URL and notification
callbacks, the shared `passwordPolicy`, and credential revocation through
`onCredentialsChangedTransaction` when revocation must commit with an account change. Proof
lifetimes default to one hour for reset, activation, and email change, and seven days for
invitations. `emailPasswordManagement` requires `emailVerification` plus its activation URL
and notification callback, because inactive address changes complete through activation.
`tokenSecretLength` defaults to 40 bytes. The application owns mail delivery and
permission callbacks; invitations deny by default when permission is not configured.
Profile fields require `registration.mapFields` and the adapter's `updateRegistrationData`
method. The maintained Lucid adapter uses its configured `mapRegistrationData` callback for
both creation and updates.

## How it works

![An invitation with a role is sent, the invitee checks the link and sets a password, and a second use of the link fails](assets/demos/invitations.svg)

![An email change sends a confirmation link to the new address; once it is used the address changes and the old address is told](assets/demos/email-change.svg)

![A password change on one device signs out the other: its token is rejected with 401](assets/demos/password-change.svg)

### A link inspection does not consume proof

`passwordReset.inspect`, `emailVerification.inspect`, and
`emailPasswordManagement.inspectEmailChange` return a boolean for an unexpired proof bound to
the account's current email state. They do not alter it. Completion is an explicit operation:
reset, activation, and email change consume a matching proof once in the same transaction as
their account update. Activation and reset establish a password under the shared policy and
reconcile the account's credentials through the configured hook.

### A resend inside one minute preserves the link

Activation resend and a repeated request for the same pending address return the same successful
acknowledgement inside one minute. They do not issue another message or replace the link. A
later resend, or one after the link has expired, replaces the proof. An active account's pending email change leaves its confirmed
address usable until completion. Requesting that confirmed address cancels a pending change;
requesting another pending address supersedes it. An inactive account's new address changes both
address columns and receives an activation link. It stays inactive until the recipient submits
that link with a new password.

### Profile updates write only configured account fields

`emailPasswordManagement.updateProfile({ actorId, currentPassword, email?, registrationData? })`
uses the current password as identity proof. The email follows the same pending-address branches
as `requestEmailChange`, while `registrationData` passes through the configured field mapper
before the adapter. Both writes occur under one account lock and transaction; a failure in
either rolls back both. The returned account is reloaded after those writes. Transform it to
an explicit HTTP representation instead of serializing adapter or model internals.

### Invitation authority is fixed at issuance

Send, resend, list, and revoke require configured application permission. Acceptance is
password-based and consumes the invitation once. It does not recheck the inviter's later
permission or disabled state. The `role` is opaque application data; use
`onInvitationAccepted(user, invitation, trx)` for required membership or role writes in the
acceptance transaction. Closed ordinary registration does not disable invitation acceptance.

### Signing in with the invited address

An invited person may never open the link: the email is late, or they click "Sign in with Google"
first. When core first confirms control of an address that holds an unused, unexpired invitation,
it accepts that invitation the way the link would. That happens in three places:

- a new social account whose provider reports the address as verified;
- account activation (`emailVerification.complete`, or a social confirmation), which also covers a
  password registration and an unverified provider address;
- a password reset (`passwordReset.reset`) that confirms an account whose address was never
  confirmed.

In the same transaction, the invitation is deleted and `onInvitationAccepted(user, invitation, trx)`
runs. After commit, `invitation.accepted` is reported with the same fields as for the link. If the
callback throws, the new account, the activation or the reset is rolled back and the invitation stays. A
missing or expired invitation changes nothing. The emailed link then answers `InvalidTokenError`,
because the invitation was already accepted by signing in.

An existing account never accepts an invitation, and changing the account's email to an invited
address does not accept it either. The `invitations` capability must be enabled. Social sign-up must
also be allowed by `registration.availability`, and `admit` still runs first.

## Files and migrations

`src/password_reset.ts`, `src/verification.ts`, and `src/credentials.ts` implement proof
inspection, issuance, and completion. `src/invitations.ts` retains issuance-time invitation
authority. No application file is generated by these service changes. Managed route wiring is
an application integration step.

## Before deployment

Route email-link GET requests to read-only inspection or an application confirmation page. Use
POST for completion, and set `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on
proof responses. Redact the token path segment from access logs. Present the same public
acknowledgement for known and unknown password-reset addresses, including delivery or
post-commit failures; inspect operational failures privately. Protect application-owned routes
with the selected credential revocation and verified-account policies. Configure invitation
permissions explicitly and keep the accepted role's business meaning in application code.
