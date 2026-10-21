# Recipes and how-to guides

Start with the [complete API walkthrough](../guides/core-api.md) for an end-to-end service
integration. These guides cover individual choices and tasks.

## Add one capability to an existing application

Choose your [stack and starting point](../guides/adoption-paths.md) first. These focused tasks
preserve the starting application's working login and selected guard:

- [Add reset to an existing API login](password-reset-existing-login.md).
- [Require verified email on an application route](verified-email-route.md).
- [Inspect another account's access](account-access-inspection.md).
- [Send account mail through AdonisJS Mail](development-mail.md).
- [Add an application-specific user field](custom-user-model.md).
- [Replace one managed endpoint](replace-managed-endpoint.md).

Each recipe names prerequisites, changed files, middleware order where applicable, expected behavior and its
execution evidence. Use the stack variants it actually supports; a JSON response does not prove a
browser form.

## Authentication and browser apps

- [API-only login with access tokens](access-tokens.md)
- [Browser login with sessions](sessions.md)
- [Inertia and React](inertia-react.md)
- [Google and GitHub sign-in with Ally](social-login.md)
- [Magic-link sign-in](../magic-link.md)
- [Signed-in devices](../signed-in-devices.md)
- [Admission](../admission.md)

## Users and account data

- [Custom user model](custom-user-model.md)
- [Custom user table or ID type](../custom-schema.md)
- [Drizzle, Prisma, and plain SQL users](../adapters.md)
- [Custom users adapter](custom-adapter.md)
- [Multi-tenant applications](multi-tenant.md)
- [Account export and deletion](../account-data.md)

## Email and notifications

- [Custom email templates](email-templates.md)
- [Development mail](development-mail.md)

## Operations and quality

- [Testing account flows](testing.md)
- [Audit log](audit-log.md)
- [Guided setup](../setup.md)
- [Operations](../operations.md)

## HTTP integration choices

- [Application-owned routes](../application-owned-integration.md)
- [Managed JSON routes](../managed-http.md)
- [Managed social routes](../managed-social.md)
- [Application-owned social routes](../social-reference.md)
