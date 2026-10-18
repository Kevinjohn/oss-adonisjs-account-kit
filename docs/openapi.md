# OpenAPI document

Applications that register the [managed JSON backend](managed-http.md) can generate an OpenAPI 3.1
document for exactly the routes they mounted. Use it for client generators, API reference pages
and contract tests.

## Configuration

Nothing extra is needed for the default routes. When the application replaces a validator or the
account representation, pass the matching schemas to `registerManagedRoutes`:

```ts
registerManagedRoutes(router, {
  prefix: '/api/v1',
  kit: () => app.container.make(AccountKit),
  guard: selectedExistingGuard,
  enabled: ['authentication', 'registration', 'emailPasswordManagement'],
  extensions: {
    registration: { validate: (context) => context.request.validateUsing(signupValidator) },
    representAccount: (account) => ({ id: account.id, email: account.email, plan: 'free' }),
  },
  openapi: {
    accountSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        email: { type: 'string' },
        plan: { type: 'string' },
      },
      required: ['id', 'email', 'plan'],
    },
    requestBodies: {
      'auth.signup': {
        type: 'object',
        properties: { email: { type: 'string' }, password: { type: 'string' } },
        required: ['email', 'password'],
      },
    },
  },
})
```

- `accountSchema` is required when `extensions.representAccount` is set.
- `requestBodies` is required for each mounted endpoint whose validator is replaced:
  `auth.signup` (`extensions.registration`), `auth.invitation.accept`
  (`extensions.invitationAcceptance`) and `account.profile.update` (`extensions.profile`).
- Generation stops with an error naming the missing schema. A replaced validator on a route that
  is not mounted needs no schema.

## Generating the document

From the command line:

```sh
node ace account-kit:openapi --output=openapi.json
```

| Flag            | Default                                                         |
| --------------- | --------------------------------------------------------------- |
| `--output`      | Print to stdout. A relative path is resolved from the app root. |
| `--title`       | `name` in the application's `package.json`                      |
| `--api-version` | `version` in the application's `package.json`                   |

The command boots the app, commits the router (which also runs the managed route collision
checks), and reads what `registerManagedRoutes` recorded. It takes the session cookie name from
`session.cookieName`. It exits with code 1 when no managed routes are registered.

From code, after the routes are registered:

```ts
import router from '@adonisjs/core/services/router'
import { generateManagedOpenApi, managedRouteRegistration } from 'adonisjs-account-kit/http'

const document = generateManagedOpenApi({
  registration: managedRouteRegistration(router)!,
  info: { title: 'Accounts API', version: '1.0.0' },
  sessionCookieName: 'adonis-session',
})
```

`accountSchema` and `requestBodies` passed here override those given to `registerManagedRoutes`.

## How it works

### Only mounted routes are documented

The document lists the routes `registerManagedRoutes` mounted: the same prefix, capabilities,
`except` list and guard strategy. Session documents include `auth.csrf`; access-token documents
include `auth.oauth.complete` and `auth.oauth.token`. Each `operationId` is the endpoint name (for
example `auth.passwordReset.complete`) and each operation is tagged with its capability.

### Responses

- Success bodies are the bodies the handlers send. Login and signup include `token` only for
  access-token guards.
- Every write, and the GET social callback, documents `202 { committed: true }`: the change
  committed but a notification or hook failed afterwards. `auth.passwordReset.request` returns
  either its acknowledgement or that body with 202.
- Errors are documented as `application/json` and `application/vnd.api+json` (selected by
  `Accept`), with `Vary: Accept`. 429 includes `Retry-After`.
- 422 is either a package error or a validation body
  (`{ errors: [{ field, rule, message }] }`), which is also used for the password policy and for a
  duplicate signup email.
- Proof routes document `Cache-Control: no-store` and `Referrer-Policy: no-referrer`;
  `auth.csrf` documents `Cache-Control: no-store`.

### Accounts

Without an application representation, every account body is `SafeAccount`
(`id`, `email`, `unverifiedEmail`, `hasPassword`, `active`). With `accountSchema`:

- `account.profile.show` returns `Account` (the application schema).
- Endpoints that issue a credential or change the account return `IssuedAccount`, which is
  `anyOf [Account, SafeAccount]`. If the representation fails after the change committed, the
  handler falls back to the safe fields rather than lose the result.
- Social flow bodies always use `SafeAccount`.

### Security

- Session guards: a cookie scheme (`sessionCookie`) and an `X-CSRF-TOKEN` header scheme
  (`csrfToken`). Every unsafe method requires both, including public ones such as login, because
  Shield checks the token against the session. `GET auth/csrf` needs neither.
- Access-token guards: an HTTP bearer scheme. `auth.oauth.redirect` and `auth.oauth.complete` are
  optionally authenticated: `link` and `reauth` need a token, `login` does not. Access-token
  clients must send `clientChallenge` to `auth.oauth.redirect` and `auth.oauth.confirmation`.

### What the schemas do not check

Request schemas match the VineJS validators, but some rules stay on the server and are written in
the descriptions: confirmation fields must equal their password, passwords must satisfy the
configured policy, and enumerated values such as `purpose` are checked by the handler.

## Tests

- `tests/managed_openapi.spec.ts` validates both documents against the official OpenAPI 3.1
  schema and compiles every embedded schema.
- `tests/managed_openapi_conformance.spec.ts` runs the managed handlers and validates their
  bodies against the generated responses.
- `tests/managed_validators.spec.ts` checks that VineJS and the request schemas accept and reject
  the same inputs.
- `tests/managed_openapi_snapshot.spec.ts` compares the generator with the committed documents in
  `tests/fixtures/openapi/`. After a deliberate change, run `pnpm build` and
  `node scripts/openapi_snapshot.mjs`, then review the diff.
