# Managed social authentication

Managed routes for Google and GitHub sign-in through Ally: sign in, link and unlink providers,
and prove a recent sign-in for sensitive changes. For the services underneath, see
[social authentication services](social-authentication.md).

## Configuration

To turn the routes on:

- Add `socialAuthentication` to the explicit `enabled` list in `registerManagedRoutes`.
- Supply `extensions.social.providers` with the selected lowercase `google` and/or `github` names.
- Configure the same providers through the public `defineConfig({ socialAuthentication })` service
  contract and request-scoped Ally adapters.

No social route is registered by importing the package. Named routes can be removed with
`except`; an application that replaces one owns its authentication, validation, rate limit, CSRF,
and response contract.

Guard requirements:

- The selected existing guard must match Account Kit's named guard.
- Access-token guards must expose an opaque `publicCredential` function.

### Trust boundaries

- The server owns provider credentials. Managed endpoints receive only Ally's request-scoped
  callback through the configured adapter; they never accept a caller-provided provider profile.
- Google and GitHub use stable, case-sensitive provider subjects as relationship keys. A provider
  email is not an account-merging authority.
- If registration is `application`, exclude `auth.oauth.registration` until a trusted server
  `extensions.social.admit(profile, trx)` callback applies the application's creation policy
  inside the service transaction.
- Invitation acceptance remains the password-based workflow.
- Standard Ally adapters do not attest fresh provider authentication; a new OAuth code, account
  selection, callback time, or token issuance time is insufficient.

## How it works

All paths below follow the configured static prefix. The default validators use VineJS; invalid
request fields retain its 422 field/rule/message response.

### Endpoints

| Name                              | Method and path                          | Request / access                                                                                                                        | Success and retry                                                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.oauth.redirect`             | POST `auth/oauth/:provider/redirect`     | `{ intent?: 'login'\|'link'\|'reauth', purpose?, proof?, clientChallenge? }`; session CSRF; link/reauth also require the selected guard | 200 `{ authorizationUrl }`. With standard Ally, `reauth` returns 403 `E_ACCOUNT_KIT_SOCIAL_PROOF_INVALID` before redirect. Begin again after denial or an expired transaction. The URL contains only the one-use state.                   |
| `auth.oauth.callback`             | GET `auth/oauth/:provider/callback`      | Ally success query `{ code, state }` or denial query `{ error, state? }`; session cookie for link/reauth                                | 200 `linked`, `link_required`, `new` continuation, verification requirement, or `reauthenticated` proof. Session sign-in redeems the handoff server-side. Replaying the callback fails.                                                   |
| `auth.oauth.complete`             | POST `auth/oauth/:provider/callback`     | Token clients forward Ally `code` and `state` with `intent`; selected bearer required for link/reauth                                   | 200 resolution as above, with a short-lived one-use `code` after confirmed sign-in. Replaying fails. The initiating client, not the OAuth provider, makes this POST.                                                                      |
| `auth.oauth.registration`         | POST `auth/oauth/registration`           | `{ continuation, email?, registrationData? }`; session CSRF                                                                             | 200 confirmed sign-in handoff or `{ status:'new', emailVerificationRequired:true }`. Continuation is consumed once; a rejected validation/admission must start again if service expiry passes.                                            |
| `auth.oauth.confirmation`         | POST `auth/oauth/:provider/confirmation` | `{ verificationToken, clientChallenge? }`; session CSRF                                                                                 | 200 `{ authorizationUrl }` for a fresh provider callback bound to the pending identity and live email proof.                                                                                                                              |
| `auth.oauth.token`                | POST `auth/oauth/token`                  | `{ code, verifier }`; access-token guard only                                                                                           | 200 `{ account, token }`. The opaque token is in the JSON body and is never put in a redirect URL. Code exchange succeeds once.                                                                                                           |
| `auth.methods`                    | GET `auth/methods`                       | public                                                                                                                                  | 200 `{ providers, lastUsedMethod }`; no account data.                                                                                                                                                                                     |
| `account.socialProof.password`    | POST `account/social-proof/password`     | `{ password, purpose }`; selected guard and session CSRF                                                                                | 200 `{ proof }`. Purpose is one of `social_link`, `social_unlink`, `password_change`, `email_change`, `account_export`, or `account_delete`; it expires in ten minutes and is single-use.                                                 |
| `account.socialIdentities.list`   | GET `account/social-identities`          | selected guard                                                                                                                          | 200 safe identity list; repeat is read-only.                                                                                                                                                                                              |
| `account.socialIdentities.unlink` | DELETE `account/social-identities/:id`   | `{ proof }`; selected guard and session CSRF                                                                                            | 204. The service consumes proof and atomically retains another usable login method. The unlink advances the credential revision, so the caller's own session or token ends with it and the client must sign in again; repeat is rejected. |

`account.socialIdentities.list` returns only `{ id, provider, email, emailVerified }` for each of
the selected guard's account identities.

### Last used method

`auth.methods` returns selected provider names and a nullable anonymous `lastUsedMethod`. No
account lookup is made for this public response.

- The built-in server-session hint is written only when `auth.methods` is mounted and a password
  login or social credential handoff succeeds. When that endpoint is excluded, no hint is recorded.
- Token clients can implement `extensions.social.rememberLastUsedMethod(context, method)` to write
  a signed visitor-local cookie after credential establishment, and `lastUsedMethod(context)` to
  read it.
- The value is allowlisted to `password` and enabled providers, contains no account identifier,
  and is never authentication authority. Record it only after a successful login or handoff, in a
  signed cookie or server-side session, and never use it to identify or authorize an account.
- A failed hint write cannot turn an established credential into a failed login.

### Session clients

- Session begin creates a fresh PKCE verifier on the server and stores it in the selected
  persistent session, keyed by the one-use state. It ignores any client challenge.
- Pending session states expire after ten minutes. Expired entries are pruned on access, and at
  most eight unfinished states are retained per session.
- On callback, the server passes that verifier to `redeemHandoff` with the selected guard and
  returns safe account data without exposing a credential. A registration continuation carries
  this server-side binding into its completion.
- The session callback never accepts a request-supplied verifier or actor ID.
- Session POST and DELETE routes require Shield CSRF state. Configure secure cookies, trusted
  origins, and shared server-side session storage.

### Token clients

- Token clients hold their PKCE verifier, send only its SHA-256 challenge to begin, and receive a
  one-use code after callback.
- For login, a provider can return to the managed GET callback.
- For linking, configure the provider's HTTPS callback at the initiating client, then forward
  `code` and `state` by authenticated POST to the managed callback route. Ally reads the POST
  inputs from the request-scoped context; Account Kit checks the state-bound provider, intent,
  actor, and link proof.
- A bearer in a URL, a client-asserted user ID, or an OAuth GET without selected-guard evidence
  cannot link an identity. Verify the callback URL and this forwarding route for each selected
  client.
- The same POST transport can carry `reauth` only for a separately trusted adapter that verifies a
  fresh authentication time and subject; standard Google/GitHub Ally callbacks cannot do so.

### Social-only accounts and recent proof

With the standard Ally adapters, a social-only account has no password and cannot prove a fresh
provider sign-in. To make sensitive changes:

1. Use password reset to set a first password.
2. Sign in with that password.
3. Require password re-entry as `currentPassword` for profile email and password changes. Use
   `account.socialProof.password` with `social_link` or `social_unlink` when managing provider
   relationships.

The service checks the account's password state under lock, so a supplied `recentProof` never
substitutes for `currentPassword` once a password exists. Setup blocks social selection without
the password-reset fallback. A failed standard-adapter reauthentication begin does not redirect
to the provider; the client should offer the password-reset path.

A trusted adapter may support provider-only reauthentication through
`verifyFreshAuthentication(callback, { state, subject })` when it verifies the provider's actual
authentication time and subject. Neither callback receipt time nor ID token `iat` is proof of
fresh authentication.

### Sign-in and registration outcomes

- An existing confirmed provider subject signs in even when registration is closed.
- New identities follow `open`, `closed`, or trusted `application` admission.
- Missing or unverified email uses the service's transaction-bound collection and verification
  continuation.
- A matching existing email returns `link_required` without account details or a credential.
- Provider denial, missing callback input, state mismatch, replay, provider failure, or local
  failure returns a generic package error; restart the begin flow.
- A failed notification after a committed write, including the GET social callback, returns 202
  `{ committed: true }`. Clients must reconcile through the account and methods endpoints rather
  than retry a consumed state.

### Headers and errors

Every social state, continuation, proof, and handoff endpoint sends `Cache-Control: no-store` and
`Referrer-Policy: no-referrer` and consumes the managed client limit.

Package failures use `{ errors:[{ code,message }] }`, or JSON:API `{ errors:[{ code,title }] }`
when requested. Common statuses:

| Status | Meaning                                   |
| ------ | ----------------------------------------- |
| 400    | Invalid social transaction                |
| 401    | Missing guard                             |
| 403    | Invalid recent proof                      |
| 409    | Conflicting identity or last login method |
| 429    | Rate limited, with `Retry-After`          |

The stable social service error codes are preserved; internal exception and database messages are
not serialized. There is no idempotency-key contract.

## Files and migrations

- `src/http/routes.ts` adds the named social inventory, guard-specific token routes, and collision
  checks.
- `src/http/social.ts` delegates every relationship, proof, and handoff transition to
  `kit.socialAuthentication`.
- `src/http/managed.ts` applies the same guard, CSRF, error, and rate-limit boundary as other
  managed routes.

Social account responses return the service safe account shape; `extensions.representAccount`
applies to password-managed responses only. The application adds its selected Ally configuration
and explicit route mount; no social controller is generated for the standard flow.

## Before deployment

1. Register the exact selected callback URLs in the provider consoles. For GitHub, request
   `user:email` through Ally.
2. Store client IDs and secrets only in deployment environment values.
3. Redact the state or proof-bearing values on `auth/oauth/:provider/callback`,
   `auth/oauth/registration`, and `auth/oauth/token` from URL, body, and error logs. Also redact
   the existing proof path segments listed in [managed HTTP](managed-http.md).
4. Configure notification delivery to the confirmed account address.
5. With test provider accounts, exercise denial, replay, missing email, matching email, closed
   registration, linking, unlinking, and both guard flows. Deterministic fixtures alone do not
   establish a live-provider result.

On suspected unauthorized association, call `account.socialIdentities.unlink` and reset the
password; either order is safe, because both end every established session and token. List the
linked identities again afterwards to confirm nothing was relinked in between.
