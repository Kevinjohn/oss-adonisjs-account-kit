# Social authentication services

The service-level contract for Google and GitHub sign-in: how a provider account maps to a local
account, how linking is proven, and how sign-in hands off to your guard. For routes, see
[managed social authentication](managed-social.md) or the
[application-owned social reference](social-reference.md).

## Configuration

Enable `socialAuthentication` and `emailVerification` together, configure the existing
`authentication` guard, and configure the shared `registration` policy. Only lowercase `google`
and `github` are supported.

### Provider adapters

Each `socialAuthentication.providers` entry adapts
[AdonisJS Ally](https://docs.adonisjs.com/guides/auth/social-authentication):

- `authorizationUrl(state, context)` starts its redirect with Account Kit's state and optional
  request context.
- `resolve(callback)` calls Ally's user operation after checking denial and state errors.

For Ally 6, a request-scoped adapter may use
`ally.use(provider).stateless().redirectUrl(request => request.param('state', state))` and
`ally.use(provider).stateless().user()`; the package's one-use database state supplies callback
binding.

The exported `createAllySocialProvider` helper maps Ally's normalized profile and discards provider
tokens and original fields. Account Kit does not store those tokens or implement OAuth exchange
itself.

- The helper maps Ally's `emailVerificationState === 'verified'` to `emailVerified: true`; both
  `unverified` and `unsupported` map to false.
- Google and GitHub subjects are opaque, case-sensitive strings up to 255 characters; provider
  names are lowercase fixed namespaces.
- Provider email is never the relationship key.

### Registration policy

| `registration.availability` | New social accounts                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `'open'`                    | Created automatically when no fields are required                                    |
| `'closed'`                  | Blocked; existing confirmed identities may still sign in                             |
| `'application'`             | Return a `new` continuation; your server code decides through `completeRegistration` |

- A configured `mapFields` requires a continuation and runs even when its input is undefined.
- In application mode, server code must call `completeRegistration` with a trusted
  `admit(profile,trx)` callback after its own signup decision. The callback runs inside the
  creation transaction, may reject, and must use the transaction for database writes. It must not
  make remote side effects, because a failed transaction may be retried.
- Managed setup must diagnose application mode unless it has an explicit trusted extension.
- Social invitation acceptance remains unsupported; invitations use the password-based path,
  including when public registration is closed.

### Notifications

Set `notify.socialIdentityLinked` and `notify.socialIdentityUnlinked`, or use the maintained
`createMailNotifications` callbacks for both.

- The maintained messages name the provider and contain no credential or action link.
- They receive the account and relationship after the database commit, only when the account has
  a confirmed email address at the time of the change.
- Delivery failures surface after commit; callers must not repeat the relationship operation in
  response.

The selected guard's revision or token check applies to authenticated linking, listing, unlinking,
and sensitive proof operations.

## How it works

### A provider subject resolves one relationship

1. Call `kit.socialAuthentication.begin({ provider, intent: 'login', clientChallenge, context? })`
   to receive `{ state, url }`. `clientChallenge` is the base64url SHA-256 digest of a verifier
   retained by the initiating client or browser server session.
2. `callback({ state, callback })` exchanges through the configured Ally adapter and consumes the
   server-stored state once.

Login resolution uses only `linked`, `link_required`, or `new`:

- **`linked`**: a stored confirmed subject, even if its provider email changes.
- **`link_required`**: a matching email without a stored relationship. No credential is returned.
- **`new`**: account creation follows the shared registration mapping. Missing email or required
  fields return `{ status: 'new', continuation }` for
  `completeRegistration({ continuation, email?, registrationData?, admit? })`. Completion rechecks
  that the provider is still configured before creating an account; disabling it invalidates the
  continuation. A new unverified-email account returns
  `{ status: 'new', emailVerificationRequired: true }` and no credential handoff.

### Unverified provider email

A verified provider email establishes a locally active, passwordless account. An unverified,
missing, or unsupported assertion creates an inactive account only after an address is supplied.
Its new provider association is quarantined (`confirmed_at` null) and cannot sign in.

To confirm it, combine the verification email and a fresh callback:

1. `beginConfirmation({ provider, verificationToken, clientChallenge, context? })`, then
   `callback({ state, callback })`. The proof hash is bound to the one-use state and must match the
   same pending user and provider subject.
2. One transaction consumes the email proof, confirms only that association, removes other pending
   associations, and activates the account.

An integration must route this email link into joint confirmation, not generic
`emailVerification.complete`. Generic email-owner claim or password reset deletes pending
associations without promoting one. Confirmed associations survive password reset and credential
revocation.

This prevents an attacker who controls a provider account but supplied somebody else's unverified
email from gaining that account after the real email owner claims it.

### Signing in with the invited address

A new account whose provider-verified address holds a pending invitation accepts it in the same
transaction: the invitation is deleted, `onInvitationAccepted` runs, and `invitation.accepted` is
reported after commit. An unverified provider address leaves the invitation alone until the address
is confirmed. Signing in to an existing account never accepts one. See
[Signing in with the invited address](account-operations.md#signing-in-with-the-invited-address).

### Linking and sensitive actions require recent proof

**Linking**

- `begin({ provider, intent: 'link', current, clientChallenge, proof })` binds a callback to the
  authenticated account, intent, and recent proof.
- A password account obtains a 10-minute, single-use `social_link` proof via
  `provePassword({ current, password, purpose: 'social_link' })`.
- The link callback requires `{ state, callback, current }`, consumes the proof bound at begin, and
  cannot transfer an identity already linked elsewhere. An application can also supply a fresh
  proof directly to the callback when it has an authenticated completion channel.
- No recent proof goes into a provider URL.

**Listing and unlinking**

- `list` and `get` expose confirmed associations only.
- `unlink({ current, identityId, proof })` consumes a `social_unlink` proof and atomically keeps a
  usable password or another confirmed, currently enabled provider.
- Unlinking is a credential change with operation `social_unlink`. It advances the credential
  revision inside the same transaction, so sessions and access tokens already established through
  the removed provider end, including the session that performed the unlink.
- It clears pending account-bound reauthentication, including callbacks already resolving provider
  assurance, and relinking does not revive them.
- `onCredentialsChangedTransaction` runs inside the transaction and `onCredentialsChanged` after
  commit, as for a password change.

Password accounts use `currentPassword` for email and password changes. A pre-existing session
alone never counts as recent proof.

### Provider-only recent proof

This needs a separate trusted adapter method, `verifyFreshAuthentication(callback, { state, subject })`.

- It must verify provider authentication evidence, including its integrity, audience and
  transaction binding, then return `{ verified: true, subject, authenticatedAt }` with the
  provider-attested authentication time in UTC.
- The core requires the same subject and account, the original purpose and credential revision,
  and an authentication time no more than 30 seconds before transaction creation and never in the
  future. Missing, malformed, old or future evidence fails closed.
- OAuth code issuance, SSO reuse, callback time, token issuance time, consent and decoded but
  unverified claims are not authentication-time proof.

The maintained Google and GitHub Ally adapters do not provide this assurance, so
`begin({ intent: 'reauth' })` is unavailable with them and ordinary provider callbacks cannot mint
sensitive-operation proofs. [Google documents](https://developers.google.com/identity/siwg/security-bundle)
that it does not support account reauthentication requests;
[GitHub's OAuth authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
does not provide an attested authentication time.

With the standard adapters, a social-only user can use the existing password-reset proof to
establish a first password when `passwordReset` is enabled, then re-enter that password for a
purpose-bound proof through `provePassword`. Confirmed provider relationships remain linked across
reset; outstanding proofs and account-bound states are invalidated.

A custom adapter that truly verifies fresh, bound provider authentication may enable the
provider-only path. Then `callback({ state, callback, current })` can return a proof for exactly
the requested purpose, and `emailPasswordManagement.changePassword`, `requestEmailChange` or
`updateProfile` consumes it in the existing locked account transaction. This custom path is not
implemented by the standard adapters.

### A one-time handoff establishes the selected guard

Successful confirmed sign-in returns a short-lived `handoffCode`, not a session or bearer
credential in the provider callback URL.

- `redeemHandoff({ code, verifier, guard })` checks PKCE, consumes the code once, and establishes
  only the configured session or access-token guard. Its successful result includes the validated
  provider name for a visitor-local last-used-method hint.
- The code is bound to the original confirmed association and credential revision; unlinking the
  provider or changing credentials invalidates an outstanding handoff.
- Redemption rechecks that relationship, account restriction, and revision after provisional
  credential issuance, and terminates a provisional credential if they changed.
- The initiating browser or token client holds the verifier outside the redirect URL. Browser
  clients use the selected session guard; token clients exchange the code with the selected
  opaque-token guard. Neither client puts a reusable credential in a redirect query string.

### Failures

Provider denial, missing callback state, expired/replayed state, unavailable provider, and
persistence failures have generic public failures. A rejected attempt starts again; an incomplete
registration resumes only with its live continuation. No provider profile can overwrite account
email, password, role, or verification after association.

## Files and migrations

- The package adds `social_transactions`, `social_sensitive_proofs`, and `social_handoff_codes`
  tables, and `social_identities` has a `confirmed_at` column. Handoff rows reference their source
  association and cascade away when it is removed.
- `src/social_identity.ts` owns local resolution and proof transitions; the existing user adapter
  and selected guard remain the identity and credential boundaries.
- Cleanup removes expired transaction, sensitive-proof, and handoff rows in bounded batches.
- The optional Ally adapter is supplied by the integrating application; service-only imports do
  not require Ally, Auth, Session, Mail, or HTTP validation packages.

## Before deployment

1. Apply the generated migrations.
2. Configure Ally's Google and GitHub credentials from environment references, exact callback
   URLs, scopes, and provider-console redirect settings. Do not put credentials in version control.
3. With a private test account, run the Google redirect and callback in both supported guard
   modes. Record the returned stable subject, email-verification state, denial, invalid state, and
   handoff replay outcomes.
4. Run the same checks for GitHub, including a private or absent email and the corresponding
   collection and local-verification continuation.
5. For each provider, also verify linked sign-in after provider email change, matching-email
   `link_required`, joint confirmation, and password-proven account linking and unlinking.
6. Verify that provider-only reauthentication is rejected with the standard Ally adapters, and
   exercise the password-reset then password re-entry recovery path for social-only users.
7. Record which checks were actually performed; deterministic fixtures do not establish a
   real-provider result.
8. Configure a confirmed-address notice delivery callback.

On suspected unauthorized association, unlink through the account service/endpoints and reset the
password; either order is safe, because both steps end every established session and token. After
both, list the linked providers again to confirm that nothing was relinked in between.
