# Account Kit documentation

## Choose your stack and starting point

For an existing application, start with [the reset-only integration guide](guides/password-reset-existing-app.md)
to keep your working login and add password reset. The [stack and starting-point selector](guides/adoption-paths.md)
gives the exact recipe for React, Vue, Hypermedia/Edge and API. The [annotated API starter diff](guides/password-reset-starter-diff.md)
shows the file-by-file changes; the complete new-application examples are secondary paths.

The reset guide preserves the application's login route, user model and guard, and documents the
required login-controller revision update, revision-check middleware and server-side sessions for
session stacks. Compare the examples with the
[shared account journey acceptance guide](guides/example-acceptance.md).

## Tutorial

- [Build one account API](guides/core-api.md): the recommended complete API-starter path from signup
  and ownership proof through protected settings and reset.
- [Getting started](getting-started.md): focused install and password-reset tutorial.
- [See it run](recordings.md): selected terminal recordings of account flows.

## How-to guides

Browse the [recipes index](recipes/index.md) for authentication, user data, email, operations, and
quality guides. It links directly to every topic.

## Reference

Browse the [reference index](reference/index.md) for configuration, service operations, endpoints,
errors, production requirements, and compatibility details.

## Explanation

- [Features](features.md): core account flows and additional capabilities.
- [Security model](security.md)
- [How setup works](how-setup-works.md): preview, recovery, and readiness.
- [Production boundaries](production-boundaries.md): readiness, delivery, and credential lifecycle.
- [Authentication integration](authentication.md)
- [Identity creation](identity-creation.md)
- [Registration](registration.md)
- [Social authentication services](social-authentication.md)
