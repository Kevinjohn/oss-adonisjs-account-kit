# Account Kit documentation

## Choose your stack and starting point

For an existing application, start with [the reset-only integration guide](guide/password-reset-existing-app.md)
to keep your working login and add password reset. The [stack and starting-point selector](guide/adoption-paths.md)
gives the exact recipe for React, Vue, Hypermedia/Edge and API. The [annotated API starter diff](guide/password-reset-starter-diff.md)
shows the file-by-file changes; the complete new-application examples are secondary paths.

The reset guide preserves the application's login route, user model and guard. Session stacks also
need a login-controller revision update, revision-check middleware and a server-side session store;
the API recipe uses bearer-token revocation without a session adapter. Compare the examples with the
[shared account journey acceptance guide](guide/example-acceptance.md).

## Tutorial

- [Build one account API](guide/core-api.md): the recommended complete API-starter path from signup
  and ownership proof through protected settings and reset.
- [Getting started](guide/getting-started.md): focused install and password-reset tutorial.
- [See it run](guide/recordings.md): selected terminal recordings of account flows.

## How-to guides

Browse the [recipes index](recipes/index.md) for authentication, user data, email, operations, and
quality guides. It links directly to every topic.

## Reference

Browse the [reference index](reference/) for configuration, service operations, endpoints,
errors, production requirements, and compatibility details.

## Explanation

- [Features](guide/features.md): core account flows and additional capabilities.
- [Security model](guide/security.md)
- [How setup works](guide/how-setup-works.md): preview, recovery, and readiness.
- [Production boundaries](guide/production-boundaries.md): readiness, delivery, and credential lifecycle.
- [Authentication integration](guide/authentication.md)
- [Identity creation](guide/identity-creation.md)
- [Registration](guide/registration.md)
- [Social authentication services](guide/social-authentication.md)
