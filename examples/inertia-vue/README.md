# Inertia Vue account example

A runnable AdonisJS 7 application that composes signup, email verification, login, protected access,
account settings, password reset and logout with Account Kit. The backend owns the user model,
validation, authorization, English copy, delivery callback and session policy. Account Kit handles
proof consumption and credential revisions.

## Requirements and run

Use Node.js 24 and pnpm 11.23.0 from the repository root. The contributor workflow packs the local
source because the matching package release is not published yet:

```sh
nvm use
pnpm install --frozen-lockfile
pnpm kit:pack
cd examples/inertia-vue
pnpm install
cp .env.example .env
node ace generate:key
node ace codegen
node ace migration:run
pnpm dev
```

Open <http://localhost:3333/signup>. Create an account, then use the verification URL printed by
the development email logger in the server output. After confirming, sign in and visit the dashboard
and settings pages. `createLogNotifications` prints proof URLs to the terminal and refuses to run in
production; it does not deliver mail to a recipient. The database and limiter use SQLite and the
session store uses the configured database driver.

The root install supplies the build tools used by `pnpm kit:pack`. Packing creates the ignored
`vendor/adonisjs-account-kit.tgz`; the example's committed pnpm lockfile records the archive
integrity. The contributor install omits frozen mode because each locally built archive changes its
integrity. Commit a lockfile refresh only when dependencies change.

### Consumer install status

The consumer path is blocked on publication of the matching Account Kit release. The registry
package currently returns 404 and there is no matching GitHub release/tag, so this example does not
invent a version. Once published, replace the local archive dependency with the exact released
version, refresh `pnpm-lock.yaml`, and document the frozen consumer install here.

## Account journey and policy

- Signup creates one account and signs it in with limited access while the email is unverified. A
  committed signup whose verification delivery fails keeps the account; the user signs in and uses
  the dashboard resend action instead of submitting signup again.
- Verification links are public and inspected without changing the current browser identity.
  Completion consumes the proof, confirms the address and ends the browser session. Invalid, used
  and expired links direct the user back to sign in and request a new verification message.
- The dashboard is signed-in limited access. The `/account` page is a real verified-only route;
  its middleware uses `kit.authentication.requireActive` and sends unverified accounts back to the
  dashboard with a recovery message. The browser journey tests guest, unverified, verified and
  logged-out access on this route.
- Password reset requests return the same acknowledgement for known and unknown addresses. Proof
  inspection is read-only; completion changes the password once and ends every session, including
  the current browser. Invalid, used or expired links can be replaced from the reset request page.
- Profile edits require the current password and only update the signed-in user's full name.
- Email requests require the current password and leave the old sign-in address active until the
  new owner confirms by POST. Cancellation invalidates the pending proof. Completion ends current
  sessions; sign in with the new address. Confirmation inspection does not switch the current
  browser identity.
- Password changes require the current password. The current browser signs in again with the new
  password; other sessions are rejected on their next request by the credential revision check.
- Logout is a protected POST and ends the current session.

Forms submit through Inertia. Vine validation errors remain associated with labels, are summarized
in a focusable alert, and move keyboard focus to that summary. Password fields clear after form
errors and success; ordinary invalid fields remain in the Inertia form. Plain HTML validation
flashes only the non-secret signup name and email fields. Inertia validation requests do not flash
submitted input into the server-side session. Vue forms send field validation to Vine instead of
stopping at native browser constraints. Success and recovery messages are announced after
redirects. Route tokens use the Vue `Form` component's `params` prop, and `aria-invalid` is present
only while a field has an error.

## What differs from the official Vue starter

This application follows the Vue starter's `<script setup>` pages, Inertia Vue `Form`, Vite Vue
plugin, Vue page indexing and AdonisJS server conventions. Account Kit adds the user/account schema,
Lucid adapter, signup and session controllers, proof pages and controllers, settings validators,
session guard/revision middleware, exception handling, SQLite tests and the notification logger.
The React example's server files are reused as application behavior; its React components and
runtime are not included.

## Minimum transplant map

To add a flow to an existing AdonisJS Vue/Inertia application, adapt the following cohesive files
from this example rather than replacing the existing frontend foundation:

| Flow                              | Server files                                                                                                                                                                                     | Vue page and route                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Signup and login                  | `app/controllers/new_account_controller.ts`, `session_controller.ts`, `app/validators/user.ts`, `app/services/session_guard.ts`                                                                  | `inertia/pages/auth/signup.vue`, `login.vue`; guest routes in `start/routes.ts`                         |
| Verification and protected access | `email_verifications_controller.ts`, `app/validators/account.ts`, `app/services/token_page_headers.ts`, `app/middleware/verified_account_middleware.ts`, `app/controllers/account_controller.ts` | `inertia/pages/auth/verify_email.vue`, `inertia/pages/account.vue`; verified route in `start/routes.ts` |
| Password reset                    | `app/controllers/password_resets_controller.ts`, `app/validators/account.ts`                                                                                                                     | `inertia/pages/auth/forgot_password.vue`, `reset_password.vue`                                          |
| Profile/password/email settings   | `profile_controller.ts`, `passwords_controller.ts`, `email_changes_controller.ts`, related validators, `session_revision_middleware.ts`                                                          | `inertia/pages/settings/*.vue`, `auth/confirm_email_change.vue`; authenticated routes                   |

Also adapt `config/account_kit.ts`, the `User` model and migrations, `start/kernel.ts`, exception
handler, shared Inertia props and your application's own layouts. Keep your existing user fields,
validation rules, authorization policy and language. If you use `@adonisjs/i18n`, resolve copy in the
application and use its English fallback. Do not add package-level locale detection or translation
files. Choose and document which routes require verified email and whether a successful credential
change keeps the current session or ends it.

## Checks and evidence

Run these commands from `examples/inertia-vue` after the root package install and contributor pack:

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Browser tests use an isolated SQLite database, temporary file notification callbacks and memory
limiter/session stores. They exercise rendered form behavior and callback URLs, not delivery into a
recipient inbox. The tested starter source is
[`adonisjs/starter-kits/inertia-vue` revision `46d235932e3eb6472a16b740fa0b47b5f69fc6fc`](https://github.com/adonisjs/starter-kits/tree/46d235932e3eb6472a16b740fa0b47b5f69fc6fc/inertia-vue).
This example was based on Account Kit source `ae42132e6182690f7a91d4119a97dee98d66ce25`.

See the shared [example acceptance contract](../../docs/guides/example-acceptance.md) for the
journey boundaries and cross-example evidence record. The run-specific commands, database, browser
sizes and keyboard checks are recorded with this change; no recipient email or PostgreSQL coverage
is implied.
