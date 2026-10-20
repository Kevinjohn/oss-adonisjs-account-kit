# Application-owned social reference

How the [API example](../examples/api/README.md) wires Google and GitHub sign-in through its own
controllers. For managed routes instead, see [managed social authentication](managed-social.md).

## Configuration

The API example enables `socialAuthentication` beside `emailVerification`, the existing selected
guard, and open registration with a trusted `fullName` mapping. The package owns local identity,
proof, state, and PKCE handoff records.

### Ally

- The application configures [AdonisJS Ally](https://docs.adonisjs.com/guides/auth/social-authentication)
  for Google and GitHub with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, and
  `GITHUB_CLIENT_SECRET`; credentials belong in deployment secrets. GitHub requests `user:email`.
- The Ally adapter uses `stateless().redirectUrl` with the package state and `stateless().user()`
  on the callback request.
- The database state replaces Ally's cookie state. It is single use, short lived, and bound to the
  intent, initiating challenge, and authenticated actor where required.
- Ally's access and refresh tokens are discarded after profile resolution.

### Guard and callback URL

- **Session mode**: set `ACCOUNT_KIT_AUTH_STRATEGY=session` for the existing `web` guard with a
  server-side session store. Its Ally callback URL is `/api/v1/auth/oauth/:provider/callback` on
  `APP_URL`.
- **Token mode**: for the existing `api` token guard, set `SOCIAL_CLIENT_CALLBACK_URL` to the
  initiating client's exact registered OAuth redirect URI, register it for each provider, and
  implement the client continuation below. The example has no frontend. Outside tests, token mode
  requires this setting. The API callback fallback is test-only; it cannot complete authenticated
  token linking from the provider's GET alone.

Production rejects non-HTTPS `APP_URL` and client callback URLs. Local development may use HTTP
loopback URLs.

### Registration

- The example's `registration.mapFields` requires an application-collected full name. Provider name
  and email are never passed through that mapper as trusted registration data.
- Applications with `registration.availability: 'application'` must make their own server-side
  signup decision and call `completeRegistration` with a trusted `admit` callback.
- Closed registration still permits already linked identities to sign in.
- Social invitation acceptance is not enabled here.

## How it works

### Starting a flow

`POST /api/v1/auth/oauth/:provider/redirect` starts `login` or `link`. The response contains
`authorizationUrl`; the client navigates there.

- Token clients send a 43-character SHA-256 base64url `clientChallenge` derived from a verifier
  they retain locally.
- Browser session clients receive a challenge generated from a verifier stored only in their
  server-side session.
- Linking requires the selected guard's current credential. A password account obtains a
  purpose-bound proof at `POST /api/v1/account/social/proof`; the link start sends it in the
  request body, where the service binds its hash to the transaction. An existing session alone is
  insufficient.

### Recent authentication

The standard Google and GitHub Ally adapters do not provide verified authentication-freshness
evidence. A new authorization code, consent screen, or account picker cannot establish recent
authentication for `reauth`, so provider-only `reauth` starts fail closed and do not issue
sensitive-action proof. [Google states that it does not support Google Account reauthentication
requests](https://developers.google.com/identity/siwg/security-bundle);
[GitHub's OAuth account picker](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
does not provide an authentication timestamp. This reference does not claim full provider-only
reauthentication support.

A social-only user instead:

1. Uses password reset to set a first password, and signs in with it.
2. Links and unlinks with purpose-bound proofs issued by `POST /api/v1/account/social/proof`.
3. Re-enters that password in the `currentPassword` field of the example's existing
   password-change and email-change endpoints, which require it directly.

### Session mode callback

- Ally redirects the browser to `GET /api/v1/auth/oauth/:provider/callback` with its normal `code`
  and the service `state`.
- The controller checks the pending server session transaction and passes the request-scoped Ally
  context to the service.
- When a linked or newly active identity receives a handoff code, the controller redeems it with
  the server-held verifier, establishes the existing `web` guard, then returns safe account data.
  The handoff code and verifier never enter the provider redirect URL.
- The reference session stores one pending social transaction and one registration continuation.
  Starting another flow in the same browser session replaces those pending browser bindings, so
  the earlier tab must start again. A separate browser session cannot complete either binding.

### Token mode callback

1. The provider redirects to `SOCIAL_CLIENT_CALLBACK_URL`.
2. The initiating client extracts `code` and `state` from that callback, then sends them in the
   JSON body of `POST /api/v1/auth/oauth/:provider/callback`. For `link` or `reauth`, that POST
   includes the existing bearer credential in the `Authorization` header.
3. Ally reads the forwarded `code` from the POST request, and Account Kit validates the one-use
   state, actor, intent, provider subject, and bound proof.
4. Successful sign-in returns a short-lived `handoffCode`. The initiating client sends it with its
   retained verifier to `POST /api/v1/auth/oauth/token`, and the response returns the selected
   opaque token in the JSON body.

Wrong verifier, replay, expiry, restriction, and intervening credential change reject redemption.
Keep the client callback on HTTPS and avoid writing codes, verifiers, proofs, or credentials to
logs, analytics, browser history beyond the unavoidable provider callback, or redirect query
strings.

### First sign-in

- **Matching local email**: returns `link_required` without a credential or association. The person
  signs in through an existing method, sends `{ "password": "…", "purpose": "social_link" }` to
  `POST /api/v1/account/social/proof`, and passes the returned `proof` to
  `POST /api/v1/auth/oauth/:provider/redirect` with `intent: "link"`.
- **Email or required fields needed**: returns `new` with a transaction-bound `continuation`.
  `POST /api/v1/auth/oauth/registration` collects `fullName` and, when absent from the provider,
  `email`; no account exists before completion. The application supplies the collection
  interface.
- **Verified provider email** can activate the new account. Missing, unverified, and unsupported
  email assertions require local verification; an inactive account receives no handoff code.
- **Pending social-only account**: the activation notice points to
  `GET /api/v1/auth/social-verification/:token`, which presents the email proof without consuming
  it. The client submits that proof to `POST /api/v1/auth/oauth/:provider/confirm` and completes a
  fresh provider callback before the identity becomes usable. Calling the generic
  email-verification completion endpoint for this pending account would discard its quarantined
  provider association.

### Account methods and unlinking

`GET /api/v1/account/methods` reports password availability, configured provider names, safe
linked provider labels, and `lastUsedMethod`. The response omits provider subjects and tokens.

`lastUsedMethod` is an optional signed visitor cookie containing only `password`, `google`, or
`github`. It is written after a successful password login or social handoff redemption, then read
only while that method is enabled for the current account or configuration. It is a convenience
hint across accounts in the same browser, never an identity assertion or authorization input.

To unlink, send `{ "password": "…", "purpose": "social_unlink" }` to
`POST /api/v1/account/social/proof`, then pass its returned `proof` in the JSON body of
`DELETE /api/v1/account/social/:id`. The service atomically refuses removal of the last usable
login method. Password and email changes continue to use `currentPassword` in their own request
bodies. The selected guard's access middleware protects account routes, including
application-owned routes, against revoked credentials.

### Rate limits and errors

| Limit                    | Attempts | Window     | Keyed by             |
| ------------------------ | -------- | ---------- | -------------------- |
| Starts                   | 20       | 15 minutes | protected client key |
| Confirmations            | 10       | 15 minutes | protected client key |
| Callbacks                | 30       | 15 minutes | protected client key |
| Registration completions | 10       | 15 minutes | protected client key |
| Code exchanges           | 20       | 15 minutes | protected client key |
| Password proofs          | 5        | 15 minutes | account              |
| Unlinks                  | 10       | 15 minutes | account              |

The configured limiter store must be shared across application instances in production. A limit
returns a generic 429 with `Retry-After`.

- Social and proof responses, including early parser, CSRF, and authentication failures, carry
  `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- A provider outage during authorization start returns a generic 503.
- A provider failure wrapped by the account service during callback maps to its safe 400 response.
- Other unexpected failures return a generic public error with a correlation ID; private logs
  record only a sanitized failure category and that ID.

## Files and migrations

- `examples/api/config/ally.ts` and `app/services/social_provider.ts` connect request-scoped Ally
  to the public service adapter.
- `app/controllers/social_auth_controller.ts`, `social_identities_controller.ts`,
  `oauth_token_controller.ts`, and `auth_methods_controller.ts` own the distinct HTTP transports.
- `app/services/social_request.ts` shares request parsing and selected-guard lookup.
- `app/services/social_browser_transaction.ts` keeps the session client's PKCE verifier between
  redirect, callback and registration.
- `start/routes.ts` registers the reference endpoints.
- `tests/helpers/social_provider_fixture.ts` and the functional tests simulate provider replies
  without external accounts; they cannot prove live Google or GitHub connectivity.

The example migrations match the package's social transaction and confirmation schema. No frontend
files are provided.

## Before deployment

1. Apply generated migrations and configure one supported guard with revocation middleware on
   every protected application route. Use a shared server-side session store for session mode.
2. Create separate Google and GitHub provider applications, register each exact callback URL, set
   environment secrets, and configure trusted proxy and HTTPS settings. For token mode, register
   the client's callback URI, not the backend POST URI.
3. For Google, register the exact callback for each transport. With a private Google account,
   check:
   - a verified-email registration, linked sign-in, and a matching local email returning
     `link_required`;
   - account linking, denial from Google's consent or account-selection screen, and rejected state
     replay;
   - that the session callback establishes a cookie only after the server-held verifier is
     redeemed;
   - for a token client, that its HTTPS callback forwards code and state to the authenticated
     backend POST for linking, that a wrong PKCE verifier fails, and that the one-use code cannot
     be exchanged twice;
   - that `reauth` fails closed with the standard adapter; a fresh OAuth code is insufficient.
4. For GitHub, register the exact callback and `user:email` scope.
   - Repeat linked sign-in, required-field registration, `link_required`, linking, denial, replay,
     and fail-closed `reauth` for both transports.
   - Use an account whose email visibility and provider response you control to inspect the
     actual returned email state; do not infer it from profile visibility. If the live response
     omits email, collect and verify an address, then complete the fresh provider-confirmation
     callback before expecting access. Record whether GitHub actually produced that state.
   - For a social-only account, verify the password-reset-to-first-password route and subsequent
     purpose-bound password proof separately.
5. Run deterministic fixtures for missing, unverified, and unsupported email assertions,
   pending-identity confirmation, actor mismatch, and credential-change races. These fixtures prove
   local handling; neither provider promises a convenient live account for every email state.
   Record provider, guard, environment, exact observed outcome, and any untested live case
   separately. Inspect production logs to ensure provider codes, tokens, state, handoff codes,
   proofs, and verifiers are absent.
