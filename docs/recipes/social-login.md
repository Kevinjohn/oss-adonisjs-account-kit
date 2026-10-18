# Google and GitHub sign-in with Ally

Account Kit handles account linking, email verification and the handoff to your client. Ally talks
to the provider.

## 1. Install Ally and configure the providers

```sh
node ace add @adonisjs/ally
```

Configure `google` and/or `github` in `config/ally.ts` with their client IDs, secrets and callback
URLs. The callback URL must match the route you register below exactly.

## 2. Adapt Ally for Account Kit

```ts
// app/services/social_provider.ts
import type { HttpContext } from '@adonisjs/core/http'
import { createAllySocialProvider, type SocialProviderName } from 'adonisjs-account-kit'

export function socialProvider(name: SocialProviderName) {
  return createAllySocialProvider({
    authorizationUrl: (state, context) =>
      (context as HttpContext).ally
        .use(name)
        .stateless()
        .redirectUrl((request) => request.param('state', state)),
    user: (callback) => (callback as HttpContext).ally.use(name).stateless().user(),
  })
}
```

Account Kit keeps its own one-use state, so Ally runs in stateless mode.

## 3. Enable the capability

Social sign-in needs `emailVerification` and an `authentication` guard as well. New accounts
created through a provider follow your `registration` policy:

```ts
// config/account_kit.ts
enabled: ['passwordReset', 'emailVerification', 'socialAuthentication'],
socialAuthentication: {
  providers: { google: socialProvider('google'), github: socialProvider('github') },
},
authentication: { strategy: 'session', guard: 'web' },
```

## 4. Add the routes

The simplest route is the managed one: add `socialAuthentication` to `registerManagedRoutes` and
the redirect, callback, handoff and identity-management endpoints are mounted for you. See
[managed social authentication](../managed-social.md) and the
[endpoint list](../reference/endpoints.md#socialauthentication).

To own the routes instead, follow the [application-owned social reference](../social-reference.md);
the example app's
[social controller](../../examples/api/app/controllers/social_auth_controller.ts) shows both
session and token clients.

## Rules worth knowing

- A provider account links to an existing user only when the provider says the email is verified,
  or the user proves who they are first.
- An account cannot unlink its last sign-in method.
- Ally does not report when the user last authenticated at the provider, so social-only accounts
  confirm sensitive changes through password reset.

## Further reading

- [Social authentication services](../social-authentication.md)
