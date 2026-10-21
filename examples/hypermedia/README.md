# Hypermedia account example

A runnable AdonisJS 7 application showing Account Kit in server rendered Edge forms. Account
operations live in controllers and the application owns its model, validation, authorization and
English copy. Forms work without JavaScript: Shield checks CSRF tokens, failures redirect with
field errors and safe old input, and successful posts use POST/redirect/GET.

This app follows the official Hypermedia starter at
[`adonisjs/starter-kits` revision `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`](https://github.com/adonisjs/starter-kits/tree/46d235932e3eb6472a16b740fa0b47b5f69fc6fc/hypermedia).
The scaffold alias is `hypermedia` in `adonisjs/create-adonisjs`; this example adds Account Kit
flows and application policy to that starter.

## Install and run

Use Node 24 and pnpm 11.23.0, as pinned in the repository. A published Account Kit version is not
available yet. The normal consumer install below is therefore release-blocked; the contributor
pack is for local development and verification only.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir examples/hypermedia kit:pack
pnpm --dir examples/hypermedia install --frozen-lockfile
```

The pack command creates the ignored local archive at
`examples/hypermedia/vendor/adonisjs-account-kit.tgz`. It is built from the checked-out source.
After a clean checkout, repeat the pack command before installing the example. Do not substitute
this archive for the published consumer path: the registry currently has no matching release.

Then configure the app and run its database migrations:

```sh
cd examples/hypermedia
cp .env.example .env
pnpm exec node ace generate:key --force
pnpm exec node ace migration:run
PORT=3342 APP_URL=http://localhost:3342 pnpm dev
```

The example uses SQLite at `tmp/db.sqlite3`, database-backed sessions and an in-memory rate limiter
by default. Run migrations before starting the app. Server-side sessions are required for reliable
logout: a cookie-only session can be replayed from a saved browser cookie. `APP_KEY`, `APP_URL`,
`PORT`, `HOST`, `NODE_ENV`, `LOG_LEVEL`, `SESSION_DRIVER` and
`LIMITER_STORE` are required environment values. Use a new application key for each deployment;
the checked-in test key is only for tests. The app does not send real email. In development,
verification, reset and email-change links appear in the server output. Treat those links as
password-equivalent secrets and do not share terminal output.

## Browser walkthrough

Open `http://localhost:3342` and follow these steps:

1. Choose **Create an account**, enter a full name, email and password twice, then submit. The new
   account signs in with limited access. The dashboard offers a verification resend if delivery
   failed or the link was missed.
2. Copy the verification URL from the server output into the browser. Inspecting the URL does not
   consume it. Choose a new password twice and confirm. The account becomes verified and the
   browser is sent to sign in.
3. Sign in with the confirmed email and new password. Open **Open the protected account page**.
   Signing out and visiting `/account` redirects to sign in; an unverified account is redirected
   to its limited dashboard.
4. Open **Profile settings**, change the full name and confirm with the current password. The
   submitted account ID is never used to select the owner.
5. Open **Password settings**, enter the current password and choose a new one twice. This session
   signs in again with the new password; other sessions are rejected on their next request.
6. Open **Email settings**, enter a new address and current password. The old address remains
   active while confirmation is pending. Copy the email-change link from the server output and
   submit its confirmation form. Sessions for that account end; sign in with the new email.
7. Sign out, choose **Forgot your password?**, and submit an address. The acknowledgement is the
   same for known and unknown addresses. Use the reset URL from the server output, choose a new
   password and submit. Existing sessions end. A consumed link cannot be reused.
8. Sign out again. The protected route returns you to sign in.

For keyboard recovery, submit an invalid form and use the first focused field. Each field error is
linked to its label and announced through the error region. Names and email addresses are retained
after ordinary validation errors; password fields are always cleared. Check this journey at desktop
and narrow viewport widths.

## Routes, controllers and templates

| Form or page            | Route                                                                                       | Controller                     | Edge template                                             |
| ----------------------- | ------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| Signup                  | `GET/POST /signup`                                                                          | `NewAccountController`         | `pages/auth/signup`                                       |
| Login, logout           | `GET/POST /login`, `POST /logout`                                                           | `SessionController`            | `pages/auth/login`                                        |
| Limited dashboard       | `GET /dashboard`                                                                            | `DashboardController`          | `pages/dashboard`                                         |
| Verified protected page | `GET /account`                                                                              | `DashboardController`          | `pages/account`                                           |
| Verify and resend       | `GET/POST /verify-email/:token`, `POST /email-verification`                                 | `EmailVerificationsController` | `pages/auth/verify_email`                                 |
| Password reset          | `GET/POST /forgot-password`, `GET/POST /reset-password/:token`                              | `PasswordResetsController`     | `pages/auth/forgot_password`, `pages/auth/reset_password` |
| Profile                 | `GET/POST /settings/profile`                                                                | `ProfileController`            | `pages/settings/profile`                                  |
| Password                | `GET/POST /settings/password`                                                               | `PasswordsController`          | `pages/settings/password`                                 |
| Email                   | `GET/POST /settings/email`, `POST /settings/email/cancel`, `GET/POST /confirm-email/:token` | `EmailChangesController`       | `pages/settings/email`, `pages/auth/confirm_email_change` |

The starter's `@form` component inserts Shield's CSRF field for state-changing methods. Vine
validation redirects back with an input error bag; field components associate messages with the
input and focus the first invalid field. Controller success and recoverable service outcomes use
session flash messages and redirects. Views use English application-owned text; no locale or
translation loader is shipped. This signup form requires a trimmed full name of 1–255 characters;
the app's registration adapter still maps a missing name to `null` for callers outside this form.

`SessionRevisionMiddleware` checks each signed-in session against Account Kit's current credential
revision. Password reset and email confirmation revoke sessions for the changed account. A password change
reauthenticates the current browser with the new password while other sessions fail on their next
request. The database session store also makes logout invalidate the server-side session record; do
not switch to the cookie store if saved-cookie replay must be rejected. An email change keeps the
old email and current session until the new address is confirmed.
Proof inspection is GET-only and does not consume a token or switch the current identity. Proof
completion is POST-only. Invalid, consumed and expired links show recovery guidance. If signup saves
the account but a follow-up fails, the controller preserves the account and directs the user to
wait one minute, then request a fresh verification link from the dashboard.

## Transplanting into an existing Edge app

Copy the minimum relevant pieces and adapt names to the host app:

- `config/account_kit.ts`, the limiter configuration, provider registration in `adonisrc.ts`, and
  the Account Kit migrations.
- `app/services/session_guard.ts`, `app/services/delivery_failure.ts`,
  `app/services/token_page_headers.ts`, and the session-revision middleware.
- The account controllers, validators and named middleware, then the matching form pages and
  shared `@form`, field, error and flash components.
- Native session and auth guard configuration, request limits, CSRF protection and the
  verified-account route policy.

Keep user columns, validation rules, access policy, notification delivery and wording in the
application. Do not copy the example database or its development key into a deployed app. For the
shared lifecycle and evidence contract, see
[`docs/guides/example-acceptance.md`](../../docs/guides/example-acceptance.md).

## Checks and evidence

Run the example scripts with Node 24:

```sh
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

The browser suite uses isolated SQLite and in-memory proof capture. It demonstrates callback
dispatch and link contents, not SMTP delivery or arrival in a recipient inbox. PostgreSQL is not
configured for this standalone example.

The latest app verification used revision `232a72b126b4d238b6883240d141753adf793829` for
persistent alert feedback with Node 24.21.0 and pnpm 11.23.0. The root frozen install, package
build, contributor archive pack and example frozen install passed. A fresh `.env.example` setup
generated a local key and migrated SQLite; the migration scan found all seven tables, including
the server-side `sessions` and `login_link_tokens` tables. The example `lint`, `typecheck`,
`build` and `test` scripts passed. The suite reported nine tests: one safe-old-input unit test and
eight native browser journeys. Without JavaScript, a failed login displayed its error and the
password-reset flow displayed its generic confirmation. With JavaScript enabled, the login error
remained visible after 5.1 seconds. A separate database-session run passed the saved-cookie logout
replay journey using:

```sh
SESSION_DRIVER=database PORT=3342 APP_URL=http://localhost:3342 \
  pnpm exec node ace test --suites browser \
  --tests 'profile, email change, password change, and logout follow session policy'
```

That run used Account Kit package `0.0.0` (unpublished), built from source revision
`4ba9c79a5754eb0ec462e792446658fe1549e79e`. The generated contributor archive SHA-256 was
`24d8fb1b0693338b41e51b25ddeaabc2a06ca70ea46747d4073bf584b2730c99`; it is local verification
evidence, not a published consumer release.

The HTTP smoke check returned 200 for `/`, `/signup`, `/login`, `/forgot-password`, and invalid
verification, reset and email-confirmation proof pages. Browser inspection at 1440×900 and
375×812 found readable forms without horizontal overflow. A mismatched password confirmation
kept the safe name and email, cleared both password fields, focused the invalid confirmation field,
and allowed keyboard navigation to continue to submit. The safe-input regression passed; no
unsafe mutation result is claimed. The app prints development proof links instead of sending mail,
so this run does not verify SMTP delivery or inbox arrival.
