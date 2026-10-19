# Authentication integration

How Account Kit signs people in through your existing AdonisJS Auth guard, and how it signs out
old sessions and tokens when credentials change.

## Configuration

Set `authentication` in `defineConfig` to one supported strategy and the name of an **existing** AdonisJS Auth guard. The package does not install or replace a guard. Use one managed route group with either `session` or `access_tokens`; two managed groups over the same accounts are unsupported.

```ts
authentication: {
  strategy: 'session', // or 'access_tokens'
  guard: 'web',         // existing guard name; 'api' in the token example
  canAccess: async (user, trx) => /* application restriction lookup */ true,
  clientLimit: { requests: 10, duration: '1m' },
  identityLimit: { requests: 5, duration: '1m', blockDuration: '20m' },
  tokenAbilities: ['*'],          // token guard only
  tokenExpiresIn: '1d',          // token guard only; omitted means no expiry
  tokenTable: 'auth_access_tokens', // token guard only
}
```

### Access restrictions

- The `canAccess` callback runs under the account lock before login and on protected access. The
  default callback permits access.
- Use `kit.authentication.changeRestriction({ userId, change })` for package-managed restriction
  changes. Its callback writes through the supplied transaction; the package then advances the
  credential revision and applies the selected revocation policy in that transaction.
- Account activation is a separate state: an inactive account may hold a limited credential, but
  `requireActive` denies protected actions with HTTP 403 and code `E_ACCOUNT_KIT_UNVERIFIED_EMAIL`.

### Session guard requirements

- AdonisJS Auth and Session, with a **server-side session store** that can destroy the current
  session. The maintained example rejects the cookie session store because a previously issued
  self-contained cookie could be replayed after logout.
- A shared server-side store for multiple application instances; an instance-local memory store is
  suitable only for the single-instance fixture.
- Secure HTTP-only cookies and Shield CSRF protection. JSON requests still require CSRF protection
  when cookies establish authority.
- Remember-me tokens disabled, unless their independent revocation is implemented and tested.
- Trusted proxy addresses configured before using `request.ip()` for the client limiter.
- A fixed public HTTPS origin and explicit CORS/origin policy for your browser client. CORS does
  not authenticate requests.

### Token guard requirements

- AdonisJS Auth's opaque access-token provider and its token table.
- An explicit `tokenExpiresIn` for a finite lifetime, and narrow `tokenAbilities` for privileged
  APIs.
- The selected guard authenticates the token and checks expiry. Privileged routes must explicitly
  check `user.currentAccessToken.allows('required:ability')` before acting; the example checks
  `invitations:create` before sending an invitation.
- Store bearer credentials only in a client location appropriate to the threat model, send them in
  the `Authorization: Bearer` header, and never put them in URLs or logs.

The maintained [token API reference](token-reference.md) shows the complete bearer request sequence, proof-link handling, error envelopes, and application-owned route gate.

## How it works

![Five wrong passwords get one generic error, then the address is blocked with 429 even for the right password](assets/demos/login-throttling.svg)

### Login

`kit.authentication.login({ email, password, clientKey }, guard)` checks the package user adapter's
password verifier and selected `canAccess` policy.

- It returns one public `Invalid email or password` failure for absent accounts, wrong passwords,
  disabled access, and passwordless accounts.
- Every such failure waits until `minRequestMs` has elapsed, so failure timing does not reveal
  which addresses have usable accounts; keep it above the password hash cost.
- The application derives `clientKey` from a trusted request IP, never from a caller-provided
  field.
- The guard port supplies the configured `name` and `strategy` and establishes a real AdonisJS
  session or token. It is an adapter boundary, not another credential store.

### Failed-login limits

| Budget                           | Failures | Window   | Block      |
| -------------------------------- | -------- | -------- | ---------- |
| Per client                       | 10       | 1 minute | none       |
| Per client plus normalized email | 5        | 1 minute | 20 minutes |

- Failed attempts consume both HMAC-keyed limits; successful attempts do not consume either.
- A successful login resets only that identity's failure count; it preserves failures against other
  identities on the shared client.
- Concurrent attempts already in progress can complete before their failures enter the client
  budget; subsequent attempts observe the accumulated failures.

### Credential revision

Every credential change advances `credentials_changed_at`, and older credentials stop working.

- The session adapter records the current `credentials_changed_at` revision in the session when the
  real guard logs in. The package checks it against the database on each protected request. A
  missing or stale revision fails closed.
- Login rechecks revision and restrictions after provisional establishment, and terminates a
  credential created during an intervening account change. Token login uses the configured
  abilities and expiry, then similarly deletes a provisional token if the revision changed. A login
  that verifies an old password before a committed reset cannot return usable access.
- Package password reset, password change, confirmed-email change, restriction changes, and social
  unlink advance the revision. The revision advances even when repeated changes share one clock
  tick.
- Token mode deletes **all** of that user's bearer tokens in the same transaction; session mode
  rejects existing browser sessions through the revision check.

These guarantees apply across instances sharing the same database and, for sessions, a shared
session store.

### Protected requests

The selected guard authenticates a request first. Then call
`kit.authentication.current({ userId, revision })` for safe account data, and `requireActive` for
verified routes.

- Session requests must pass their captured revision, including an initial null value.
- Token requests must pass the current guard's trusted token identifier; the package checks that
  its row is still bound to the user under the account lock. This also rejects a request whose
  token was revoked between guard authentication and protected access.
- These methods return only ID, email, pending email, password availability, and active state.

The maintained example applies `AccountAccessMiddleware` to limited routes and
`VerifiedAccountMiddleware` to verified routes, whether package-backed or application-owned. The
email-correction and activation-send routes permit a limited inactive credential while still
checking revocation and restrictions.

Outside the guarantees:

- Any application-owned route that omits the appropriate gate is outside its revocation or
  verified-account guarantee.
- Direct application writes to email, password, verification state, restrictions, or provider rows
  are likewise outside package revocation and proof invalidation; use package operations. The
  Lucid save hook still hashes a password on a direct save.

### Related features

[Magic-link sign-in](magic-link.md) issues credentials through the same guard adapter and the same post-issuance re-check. Every credential change also deletes the account's outstanding sign-in links.
[Signed-in devices](signed-in-devices.md) lists an account's sessions or tokens and revokes them individually or all at once.

### Logout and client handling

- **Session JSON client**: first GET `/api/v1/auth/csrf`, retain the HTTP-only session cookie, then
  send the returned CSRF token in `x-csrf-token` on login and other state-changing requests. Login
  regenerates the session identifier. Logout destroys the current server-side session; an old
  cookie fails, and a repeated authenticated logout returns 401 because that credential no longer
  exists.
- **Token mode**: login returns an opaque token, logout deletes the current token, and a repeat
  with the same token returns 401.

Logout does not mean universal revocation; credential changes have the per-guard policy above.
Responses never put credentials in URLs.

### Adding login to an app with signed-in users

Sessions created before Account Kit carry no credential revision, so the session guard rejects them
and those users sign in again. Existing access tokens keep working only while native AdonisJS Auth
accepts them and their rows stay in `authentication.tokenTable`. Changing the session store, session
keys, token table or Auth configuration can sign users out. Before production traffic, test an
existing session, a fresh login, a kept token and a revoked token.

## Files and migrations

- `src/authentication.ts` owns the service and revision checks; `src/config.ts`, `src/types.ts`,
  and `src/errors.ts` define the public contract.
- `configure.ts` emits `add_account_columns_to_users` as the first package migration; it adds `credentials_changed_at` to the users table, and the example includes its matching migration.
- The example's selected-guard controllers, Shield configuration, access middleware, and functional tests show both supported modes.
- The generic service declarations do not import optional Auth or Session packages; the concrete example adapters do.

## Before deployment

1. Back up user and token tables, then review and apply the users-table migration before
   activating authentication.
2. Verify that the existing guard, token table or server-side session store, CSRF middleware,
   trusted proxies, public origin, and application-owned route middleware match the chosen mode.
3. For multiple instances, use a shared limiter and session store, and deploy the middleware
   everywhere before accepting new sessions.
4. Disable remember-me tokens unless their revocation policy is separately enforced.
5. Expect existing browser sessions to sign in again: they have no captured revision.
6. Review direct account writes and move changes that require revocation to package operations.
7. Run the SQLite and PostgreSQL suites plus both packed consumer modes before deployment.
