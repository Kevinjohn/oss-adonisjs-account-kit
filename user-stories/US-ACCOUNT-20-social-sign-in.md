# US-ACCOUNT-20 — Sign in with a social provider

As a person with a configured provider identity, I want to sign in through Google or GitHub so that I can use an account under the host signup policy.

**Status:** Current for configured Ally provider and enabled `socialAuthentication`
**Access:** State and client challenge bind the callback. Existing linked identities must be confirmed; new-account eligibility follows the shared registration policy. Host owns provider credentials and callback routes.
**Entry:** Host calls `socialAuthentication.begin({ provider, intent: 'login', clientChallenge, context? })`, handles callback with `state`, then redeems a linked handoff with `redeemHandoff({ code, verifier, guard })`.
**Documentation:** [Social authentication](../docs/guide/social-authentication.md) and [managed social routes](../docs/guide/managed-social.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [`tests/social_identity_handoff.spec.ts`](../tests/social_identity_handoff.spec.ts), [`tests/social_identity_continuation.spec.ts`](../tests/social_identity_continuation.spec.ts), [`tests/managed_social_http.spec.ts`](../tests/managed_social_http.spec.ts)

## Acceptance criteria

- `begin` takes provider (`google` or `github`), intent `login`, a 43-character base64url SHA-256 `clientChallenge`, and optional adapter context; it returns `{ state, url }`. `beginConfirmation` takes provider, activation `verificationToken`, the same challenge shape and optional context, returning `{ state, url }`. Callback takes `{ state, callback, provider?, admit? }` and returns `linked`/`new` with userId and optional handoffCode, `new` with continuation, `new` with `emailVerificationRequired`, `link_required`, or `reauthenticated` with proof. It does not issue an Adonis credential in the provider redirect.
- A confirmed `linked` result carries userId and a short-lived handoffCode; `redeemHandoff({ code, verifier, guard })` checks the verifier against the challenge and returns account, actual guard credential and provider. A matching email without a relationship returns `link_required`, not sign-in.
- A `new` continuation is completed by trusted host code with `completeRegistration({ continuation, email?, registrationData?, admit? })`; closed signup refuses and application policy remains host-owned. An unverified provider email cannot sign in; confirmation uses `beginConfirmation({ provider, verificationToken, clientChallenge, context? })` followed by `callback({ state, callback })`, matching the email proof to the same pending subject.

## User flow

```mermaid
flowchart TD
 A["Client keeps verifier and sends its challenge to begin provider login"] --> B["Provider returns callback to host"]
 B --> C{"Does one-use state and provider response validate?"}
 C -->|No| D["Refuse callback without issuing credential"]
 C -->|Yes| E{"Is provider subject already confirmed and linked?"}
 E -->|Yes| F["Receive one-use handoff code"]
 F --> G{"Does redeemHandoff verifier match original challenge?"}
 G -->|No| H["Refuse redemption; no credential is issued"]
 G -->|Yes| I["Establish configured session or token guard"]
 E -->|No| J{"Does callback require link, registration data, application approval or email confirmation?"}
 J -->|link_required| K["Authenticate existing account and complete a separate link journey"]
 J -->|registration continuation| L["Host applies signup decision and calls completeRegistration"]
 J -->|unverified email| M["Confirm address with proof and fresh callback for same provider subject"]
 J -->|closed policy| N["Refuse account creation"]
```

## Code flow

Scope: provider adapter supplies provider URL/profile; Account Kit owns state, local identity resolution and handoff. Host owns Ally credentials, routes and application signup decision.

```mermaid
flowchart TD
 A["socialAuthentication.begin"] --> B["Store one-use state, intent, challenge and optional account/proof binding"]
 B --> C["Configured adapter returns authorization URL"]
 C --> D["socialAuthentication.callback consumes state and resolves provider profile"]
 D --> E{"Confirmed linked subject, new account, link_required or confirmation?"}
 E -->|linked| F["Return handoffCode bound to association and credential revision"]
 F --> G["redeemHandoff({ code, verifier, guard }) checks verifier and rechecks association/revision"]
 G --> H["Establish guard; return account, credential and provider"]
 E -->|new| I["Apply open/closed/application policy and configured field mapping"]
 I --> J["Return continuation or create eligible account"]
 J --> K["completeRegistration consumes continuation with trusted host admit callback"]
 E -->|unverified| L["beginConfirmation binds verification token to fresh confirm state"]
 L --> M["callback confirms same pending provider identity and activates account"]
 E -->|link_required| N["Return no credential; existing account must prove and link"]
```

**Code references:** [`social identity methods`](../src/social_identity.ts), [`provider callback flow`](../src/http/social.ts), [`handoff tests`](../tests/social_identity_handoff.spec.ts), [`continuation tests`](../tests/social_identity_continuation.spec.ts)
