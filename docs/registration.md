# Registration

## Configuration

The generated configuration enables `registration` and sets `registration.availability: 'open'`.
Every configuration must include availability explicitly, even when registration is disabled.
When `enabled` is omitted, both registration and invitations are disabled; applications must
select either capability explicitly.
Choose `open`, `closed`, or `application`. `open` is the recommended public default. `closed` rejects creation;
`application` lets the application own the signup decision and call the service after its own
checks. The package does not install a public registration route. Enable `emailVerification` and configure
`urls.emailVerification` and `notify.accountActivationProvision` to deliver activation proofs.

Use `registration.mapFields(input)` to validate and select additional application profile fields.
When configured, the mapping runs even if `registrationData` is omitted, so it can require profile
fields. Without a mapping, only omitted `registrationData` is accepted. The mapping returns a plain object
whose keys cannot control IDs, email, passwords, verification state, or roles. The trusted users
adapter receives only the mapped object; it must decide how to write those fields. The API example
validates `fullName` and maps only that field.

`passwordPolicy` governs newly established passwords. Its defaults are `minLength: 8`,
`maxLength: null`, `letters: false`, `mixedCase: false`, `numbers: false`, `symbols: false`, and
`minScore: 0` of 4. The service always caps passwords at 256 characters. A configured minimum or
maximum over 256, or a minimum over the maximum, is rejected. Login still verifies an existing
password even when a newer policy would reject it. The strength score estimates entropy from
length and character variety; a long passphrase can score higher without mixed case or symbols.

## How it works

![Signup creates an unverified account and emails a verification link; after the link is used, login returns an active account](assets/demos/signup-verification.svg)

`registration.register({ email, password, registrationData? })` normalizes the address and creates
an inactive account with `email` and `unverifiedEmail` equal. The account and a hashed one-use
activation proof commit in one transaction. A unique email constraint decides concurrent attempts;
all duplicate account states produce `RegistrationEmailAlreadyRegisteredError` (422). An HTTP
controller should translate it to the same `email` field error using the `unique` rule, regardless
of whether the account is verified, inactive, passwordless, or restricted.

After commit, the configured callback delivers the proof. Delivery or observer failure reports a
committed failure; the account and proof remain. Do not retry registration as if it rolled back.
The account can request a new activation proof through `emailVerification.send`, or use password
reset. Applications can establish a limited credential through `authentication.login` immediately
after successful registration. `authentication.requireActive` denies protected access with 403
`E_ACCOUNT_KIT_UNVERIFIED_EMAIL` in both bearer and session integrations. Verification resend and logout remain
available to inactive accounts.

An activation proof for an inactive account now requires a fresh password:
`emailVerification.complete({ token, password })`. The claimant's password replaces the earlier
password under the account lock. The same transaction invalidates prior bearer credentials or
advances the browser-session revision. In-flight login cannot issue a usable credential from the
old password after that claim. Active-account email changes retain their separate proof behavior.

## Files and migrations

The service and policy live in `src/registration.ts` and `src/password.ts`, with configuration and
types in `src/config.ts` and `src/types.ts`. Inactive activation is in `src/verification.ts`. The
API example provides the application-owned signup route, selected-guard credential integration,
and the password-bearing verification completion route. This capability adds no schema migration;
it uses the users and verification-proof schema described in
[identity creation](identity-creation.md).

## Before deployment

Set registration availability explicitly, review the trusted field mapping and user adapter, and
confirm the users table has a unique normalized email key. Wire the application-owned signup
controller to validate request fields and translate duplicate errors consistently. Give inactive
credentials access only to verification resend, logout, and other intentionally limited actions.
Completion is a POST with a fresh password and confirmation; a token alone does not claim an
inactive account. Exercise both
guard modes and both databases before deployment.
