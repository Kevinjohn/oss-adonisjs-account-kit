# Account Kit documentation

## Tutorial

- [Getting started](getting-started.md): install, migrate, and send your first password reset.

## How-to guides

Authentication

- [API-only login with access tokens](recipes/access-tokens.md)
- [Browser login with sessions](recipes/sessions.md)
- [Inertia and React](recipes/inertia-react.md)
- [Google and GitHub sign-in with Ally](recipes/social-login.md)
- [Magic-link sign-in](magic-link.md)
- [Signed-in devices](signed-in-devices.md)
- [Account export and deletion](account-data.md)

Users and data

- [Custom user model](recipes/custom-user-model.md)
- [Custom user table or ID type](custom-schema.md)
- [Drizzle, Prisma and plain SQL users](adapters.md)
- [Custom users adapter](recipes/custom-adapter.md)
- [Multi-tenant applications](recipes/multi-tenant.md)

Email

- [Custom email templates](recipes/email-templates.md)
- [Development mail](recipes/development-mail.md)

Operations and quality

- [Testing your account flows](recipes/testing.md)
- [Audit log](recipes/audit-log.md)
- [Guided setup with `account-kit:setup`](setup.md)
- [Upgrading from a pre-release candidate](upgrade.md)
- [Operations](operations.md): deploy, prune, operator commands, secret rotation and redaction.

Integration modes

- [Application-owned routes](application-owned-integration.md)
- [Managed JSON routes](managed-http.md)
- [Managed social routes](managed-social.md)
- [Application-owned social routes](social-reference.md)

## Reference

- [API reference](https://kevinjohn.github.io/oss-adonisjs-account-kit/api/): every export,
  generated from the source.
- [Usage](usage.md): configuration, capabilities and operation signatures.
- [Account operations](account-operations.md)
- [Errors](reference/errors.md)
- [Managed endpoints](reference/endpoints.md)
- [Setup choices](reference/setup-choices.md): the six pillars and the files setup writes.
- [OpenAPI document](openapi.md): an OpenAPI 3.1 file for the mounted managed routes.
- [Notifications](notifications.md)
- [Production requirements](reference/production-requirements.md): versions, stores and limiter
  budgets.
- [Compatibility](compatibility.md): tested versions.
- [Glossary](glossary.md)

## Explanation

- [Security model](security.md)
- [How setup works](how-setup-works.md): preview, recovery and readiness.
- [Production boundaries](production-boundaries.md): readiness, delivery and credential lifecycle.
- [Authentication integration](authentication.md)
- [Identity creation](identity-creation.md)
- [Registration](registration.md)
- [Social authentication services](social-authentication.md)
