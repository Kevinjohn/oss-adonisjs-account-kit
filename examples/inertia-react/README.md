# Inertia and React example

The AdonisJS 7 Inertia React starter kit with Account Kit added. It shows the account flows a
browser app needs, each as a plain controller and React page you can copy:

| Flow                  | Pages                                        | Controller                                          |
| --------------------- | -------------------------------------------- | --------------------------------------------------- |
| Sign up               | `/signup`                                    | `app/controllers/new_account_controller.ts`         |
| Confirm email address | `/verify-email/:token`, dashboard banner     | `app/controllers/email_verifications_controller.ts` |
| Log in and out        | `/login`                                     | `app/controllers/session_controller.ts`             |
| Forgot password       | `/forgot-password`, `/reset-password/:token` | `app/controllers/password_resets_controller.ts`     |
| Change password       | `/settings/password`                         | `app/controllers/passwords_controller.ts`           |

Emails are printed to the dev server log instead of being sent.

## Run it

You need Node.js 24 and pnpm.

```sh
cd examples/inertia-react
pnpm kit:pack
pnpm install
cp .env.example .env
node ace generate:key
node ace codegen
node ace migration:run
pnpm dev
```

Open http://localhost:3333/signup, create an account, then copy the verification link from the
server log.

`kit:pack` builds Account Kit from this checkout into `vendor/`. Once the package is on npm, replace
the `adonisjs-account-kit` dependency with the published version and skip that step.

## What was added to the starter kit

- `@adonisjs/limiter` and `adonisjs-account-kit`, each added with `node ace add`.
- A database session store (`node ace make:session-table`, `SESSION_DRIVER=database`). Session
  login needs a server-side store so that signing out cannot be undone by replaying an old cookie.
- `config/account_kit.ts`: session authentication through the existing `web` guard, open
  registration that keeps the starter's full name field, `createActionUrls` for links to the pages
  above, and `createLogNotifications` for email.
- `app/services/session_guard.ts`: lets Account Kit sign users in through the `web` guard and
  stores the credential revision in the session.
- `app/middleware/silent_auth_middleware.ts`: signs out sessions that started before the latest
  password change, on every request, so changing a password signs out every other device.
- `app/exceptions/handler.ts`: turns Account Kit errors into flash messages and sends signed-out
  sessions to the login page.
- New pages under `inertia/pages/auth` and `inertia/pages/settings`, and a verification banner on
  the dashboard.

## Before you deploy

- Add `@adonisjs/mail` and replace `createLogNotifications` with `createMailNotifications`. The log
  notifications refuse to start in production.
- Configure trusted proxies so `request.ip()` is the client address.
- Keep the reset and verification page URLs out of access logs and analytics. The pages already
  send `Referrer-Policy: same-origin`, so the token never reaches another site in a Referer.

See [Inertia and React](../../docs/recipes/inertia-react.md) and
[browser login with sessions](../../docs/recipes/sessions.md) for the reasoning behind each step.
