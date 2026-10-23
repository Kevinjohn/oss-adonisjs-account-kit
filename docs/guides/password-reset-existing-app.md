# Keep your login; add password reset

Add password reset to an existing AdonisJS 7 application while keeping its login route, user model,
route namespaces, selected Auth guard and authorization policies. Use this shared checklist before
following the token or browser recipe. Every step marked **Required** applies even when reset is
the only enabled capability; **Optional** steps depend on the application's choices.

## Package and application responsibilities

| Responsibility               | Account Kit                                                                                        | Application                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Account transaction          | Owns proof writes, account locking, password updates, credential revision and transactional hooks. | Supplies application writes through the provided transaction; never wraps an operation in another transaction.                           |
| Proof lifecycle              | Issues, hashes, inspects, expires, replaces and consumes reset proofs once.                        | Chooses proof-page URLs and keeps tokens out of logs, analytics and referrers.                                                           |
| Credential lifecycle         | Advances `credentials_changed_at`; deletes configured access tokens in the reset transaction.      | Selects the real guard/table, revokes extra credential types and enforces revision checks on existing session routes.                    |
| Validation and authorization | Exposes service input contracts and stable error codes.                                            | Owns request validation, account restrictions, route authorization and public response policy.                                           |
| User interface and language  | Supplies operations and optional managed JSON routes.                                              | Owns forms, proof pages, redirects, recovery feedback, accessibility and application translations.                                       |
| Notifications                | Invokes configured callbacks and distinguishes committed follow-up failure.                        | Chooses capture, logging or mail transport, delivery retry and production operations; callback invocation alone does not prove delivery. |

## 1. Confirm the starting application — Required

Use Node 24 and pnpm with AdonisJS 7, Lucid, a working Auth guard, and the application's existing
user model. Keep its unique, normalized email address and hashed password configuration. Resolve
pre-existing duplicate/unnormalized addresses before enabling recovery. Match the user ID type
and users table when configuring the package.

For a reproducible disposable application, use the pinned official starter command in the
[starter baselines](../maintainers/verification.md#starter-baselines), commit its untouched baseline,
and sign in through its original login route. Request a route protected by its ordinary Auth
middleware before adding Account Kit. A copy of a reference example already includes Account Kit
wiring and cannot establish an existing-application integration.

Record the baseline commit, starter revision, scaffold command, generated dependency versions and
lockfile SHA-256. For browser kits, inspect `config/session.ts`; a cookie store must be replaced
with a server-side store in step 5.

## 2. Install and configure — Required

Follow the [root install instructions](../../README.md#install) for the released archive and
configuration command. For development verification, install the archive built and packed from
the source revision being checked, and record its digest; keep release and development evidence
separate.

The required peers are AdonisJS Core 7, Lucid, Limiter and Luxon within the declared
[compatibility ranges](../compatibility.md). The application supplies its database driver. Preserve
its Auth integration. Configuration tooling also requires the supported Assembler and TypeScript
versions. Session applications retain Session and Shield; Mail is optional if another notification
transport is supplied. Install/configure Limiter before booting Account Kit, choosing the store
appropriate to the application.

Run `node ace configure adonisjs-account-kit` once after archive installation. For a non-default
schema, pass `--users-table=members` and the matching `--user-id-type=integer`, `string` or `uuid`.
Configuration preserves existing generated files; inspect conflicts instead of assuming it has
rewritten an old installation.

### Configuration output

Configuration registers the provider and commands in `adonisrc.ts`, declares `APP_URL` in
`start/env.ts`, creates `config/account_kit.ts` and generates eleven migrations. The application
continues to own its users table, model and original routes.

The exact clean-starter `git status --porcelain` inventory is recorded below after running the
configuration command, including prerequisite installation changes. Timestamp prefixes identify
one run and change on later scaffolds.

This run used the pinned API starter at baseline `145270d13bcc5da1022c2b02540ea7e61f34d7b7`,
Node `24.21.0`, pnpm `11.23.0`, Limiter `3.0.1`, and the development archive built from
`124c7790730477c974529e11460b728b96deee1e` (package version `0.1.1`, SHA-256
`38fd950b08990a95b780d3077ad65f3a98bb898cb858b7b2f9eaabaae236a3d2`). Before installation,
the untouched application's native login returned `200` and its bearer-protected profile returned
`200`; an unauthenticated profile request returned `401`. A temporary functional test exercised
those routes and was removed before this inventory.

The prerequisite command was `node ace configure @adonisjs/limiter --store=database`; the generated
configuration also exposes the memory store for tests. The Limiter installer changes `.env` as
well as the tracked `.env.example`; `.env` is gitignored and is absent from this status output.

```text
 M .env.example
 M adonisrc.ts
 M package.json
 M pnpm-lock.yaml
 M start/env.ts
?? config/account_kit.ts
?? config/limiter.ts
?? database/migrations/1792694674311_create_rate_limits_table.ts
?? database/migrations/1792694677465_account_kit_add_account_columns_to_users.ts
?? database/migrations/1792694677466_account_kit_create_password_reset_tokens.ts
?? database/migrations/1792694677467_account_kit_create_email_verification_tokens.ts
?? database/migrations/1792694677468_account_kit_create_account_invitations.ts
?? database/migrations/1792694677469_account_kit_create_account_transaction_lock.ts
?? database/migrations/1792694677470_account_kit_create_social_identities.ts
?? database/migrations/1792694677471_account_kit_create_social_transactions.ts
?? database/migrations/1792694677472_account_kit_create_social_sensitive_proofs.ts
?? database/migrations/1792694677473_account_kit_create_social_handoff_codes.ts
?? database/migrations/1792694677474_account_kit_create_login_link_tokens.ts
?? database/migrations/1792694677475_account_kit_create_account_sessions.ts
?? start/limiter.ts
```

### Shared schema — Required

Inspect every generated migration before running `node ace migration:run`. Selecting
`enabled: ['passwordReset']` limits capabilities and routes; configuration still generates the
shared schema below. Do not describe it as a reset-only migration set. The names below omit each
file's timestamp and `_account_kit_` prefix. The package uses the application's selected users
table and key type for foreign keys.

| Migration                          | Table and columns                                                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_account_columns_to_users`     | Adds nullable `email_verified_at`, `unverified_email`, `credentials_changed_at` to the users table; changes the existing `password` column to nullable.                                                                                                                     |
| `create_password_reset_tokens`     | `password_reset_tokens`: `id`, `tokenable_id`, `email`, `hash`, `expires_at`, `created_at`.                                                                                                                                                                                 |
| `create_email_verification_tokens` | `email_verification_tokens`: `id`, `tokenable_id`, `email`, `current_email`, `purpose`, `hash`, `expires_at`, `created_at`.                                                                                                                                                 |
| `create_account_invitations`       | `account_invitations`: `id`, `email`, `role`, `inviter_id`, `token_hash`, `expires_at`, `created_at`, `updated_at`.                                                                                                                                                         |
| `create_account_transaction_lock`  | `account_transaction_lock`: `id`, `version`; inserts the singleton lock row. Required by account transactions, including SQLite writer coordination.                                                                                                                        |
| `create_social_identities`         | `social_identities`: `id`, `user_id`, `provider`, `provider_user_id`, `email`, `email_verified`, `name`, `nickname`, `avatar_url`, `meta`, `created_at`, `updated_at`, `confirmed_at`.                                                                                      |
| `create_social_transactions`       | `social_transactions`: `id`, `hash`, `provider`, `intent`, `purpose`, `client_challenge`, `verification_hash`, `proof_hash`, `credential_revision`, `user_id`, `provider_user_id`, `email`, `email_verified`, `name`, `nickname`, `avatar_url`, `expires_at`, `created_at`. |
| `create_social_sensitive_proofs`   | `social_sensitive_proofs`: `id`, `hash`, `user_id`, `purpose`, `credential_revision`, `expires_at`, `created_at`.                                                                                                                                                           |
| `create_social_handoff_codes`      | `social_handoff_codes`: `id`, `hash`, `user_id`, `social_identity_id`, `credential_revision`, `client_challenge`, `expires_at`, `created_at`.                                                                                                                               |
| `create_login_link_tokens`         | `login_link_tokens`: `id`, `tokenable_id`, `email`, `hash`, `client_challenge`, `expires_at`, `created_at`.                                                                                                                                                                 |
| `create_account_sessions`          | `account_sessions`: `id`, `user_id`, `handle_hash`, `label`, `created_at`, `last_seen_at`, `expires_at`.                                                                                                                                                                    |

The [migration stubs](https://github.com/Kevinjohn/oss-adonisjs-account-kit/tree/main/stubs/migrations)
carry types, nullability, indexes and constraints. Admission is a separate opt-in installer; its
migration is not generated by this configuration command. The starter's existing access-token or
session migrations and Limiter's selected-store migration are shared prerequisites, not package
reset migrations. SQLite applications must enable foreign keys on every connection.

## 3. Select reset and the application policy — Required

In the generated `config/account_kit.ts`, retain the lazy Lucid adapter for the existing model and
set:

```ts
enabled: ['passwordReset'],
```

Keep a stable `APP_KEY` for limiter HMACs and an `APP_URL` that names the application origin. Use
public HTTPS origins in production and configure trusted proxies before using `request.ip()` as a
limiter identity. Keep the application's real restriction policy; a permissive example callback is
not a replacement for it. Do not enable registration or add new login routes to complete reset.

## 4. Provide proof pages and notifications — Required

Set `urls.passwordReset` to the application's password-reset form, with the token encoded as a
path or query component. The form must submit the proof, new password and confirmation using the
selected stack's validation and CSRF policy. Inspection is read-only; only the completion POST
consumes a valid proof. Send `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on proof
responses, including malformed requests, and avoid third-party resources on proof pages.

Replace the generated throwing notification callbacks. For a disposable local check, use
[development logging or capture](../recipes/development-mail.md). **Optional:** configure AdonisJS
Mail or an application-owned transport for real delivery. Production requires such a transport;
local capture establishes callback/proof contents, never recipient inbox delivery. The completed
notice is part of the notification contract as well as the reset-link provision callback.

## 5. Integrate the existing guard — Required

### Opaque access tokens

Select `authentication.strategy: 'access_tokens'`, the existing guard name and its actual token
table in the generated configuration. The package deletes all that user's tokens in the reset
transaction. Keep the existing login controller, token provider and protected routes. The
[token recipe](../recipes/password-reset-existing-login.md) gives the reset-only mount and guard
configuration. An empty `onCredentialsChangedTransaction` callback is appropriate only if there
are no extra application-owned sessions, API keys or remember-me credentials to revoke.

### Browser sessions

Keep the existing login route and Auth guard. Edit its successful login controller to store the
current `credentials_changed_at` revision in the session, including an explicit empty sentinel
for a null revision. An absent value must fail closed. Use the same revision representation as the
[session guard helper](../../examples/inertia-react/app/services/session_guard.ts).

Install the [revision middleware](../../examples/inertia-react/app/middleware/session_revision_middleware.ts)
after Session and Auth's silent authentication middleware, before application routes and their
Auth middleware. It passes the stored revision to `authentication.current`, terminates an old
session on `InvalidSessionError`, and lets the native protected-route middleware redirect to the
original login page. Existing protected routes need this integration too.

Use a server-side Session store such as database or Redis; add its table/configuration where
required. A copied cookie-only session can survive logout. Keep Shield's CSRF protection and
Session middleware order. Disable remember-me tokens unless the transactional credential callback
revokes them as well. See [sessions](../recipes/sessions.md) for the configuration and
[session reference](../session-reference.md) for CSRF and credential policy. A reset success
response alone never proves old sessions are rejected.

### Other credential types — Required when present

Use `onCredentialsChangedTransaction` to invalidate application-owned credentials through its
provided transaction. An exception before commit must roll back password, proof and credential
writes. Do not treat a post-commit notification or callback error as permission to repeat proof
consumption or claim the old password is still active.

## 6. Add reset routes and recovery — Required

Choose a separate namespace that cannot replace existing login or application routes. Mount only
reset, or write stack-native controllers calling the reset service. Keep proof inspection and
completion public: a signed-out user must be able to recover access. Managed JSON routes are
optional; the [token recipe](../recipes/password-reset-existing-login.md) shows that composition.
The browser recipes supply their own native forms and error presentation.

Validate email, password and confirmation in the application. Reset requests use the same generic
acknowledgement for known and unknown addresses. Handle malformed, expired, consumed, mismatched
and replaced proofs with a way to request a new link. Preserve useful non-secret input, associate
field errors with labels and deliberately choose/document password retention. Distinguish
committed failures using the [error contract](../reference/errors.md#mapping-errors-to-responses) and keep
response language application-owned through the application's i18n integration when present.

## 7. Prove reset through the original login — Required

1. Sign in with two independent clients through the original login route. Both must succeed on
   the same route protected by the starter's ordinary Auth middleware before reset.
2. Verify known/unknown request acknowledgements and repeated non-consuming GET inspection.
3. Submit malformed, expired, consumed and mismatched proofs and replace a link; each failure
   leaves the password and both existing credentials unchanged.
4. Complete the valid reset. Both old credentials must now fail on that same protected route:
   bearer clients receive `401`; session clients follow the native redirect to login.
5. The original login route rejects the old password and accepts the new password.

Use a disposable database and local notification capture. For expiry, insert a proof row with a
past `expires_at`; there is no injected clock. Record source/archive digest, starter/runtime/package
versions, commands, named test results and limits using the
[example evidence contract](example-acceptance.md#updating-the-record). A manual check is labelled
as such; a response status or row assertion cannot replace the credential requests above.
