# Recipes and how-to guides

For an existing application, start with the [reset-only integration guide](../guide/password-reset-existing-app.md)
and choose the recipe for your stack. The [complete API walkthrough](../guide/core-api.md) is the
secondary path for a new application.

## Add one capability to an existing application

Choose your [stack and starting point](../guide/adoption-paths.md) first. These focused tasks
preserve the starting application's working login and selected guard:

- [Add reset to an existing API login](password-reset-existing-login.md).
- [Add reset to an existing Inertia React login](inertia-react.md).
- [Add reset to an existing Inertia Vue login](inertia-vue.md).
- [Add reset to an existing Hypermedia/Edge login](hypermedia-edge.md).
- [Add invitations to an existing application](invitations-existing-app.md).
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
- [Google and GitHub sign-in with Ally](social-login.md)
- [Magic-link sign-in](../guide/magic-link.md)
- [Signed-in devices](../guide/signed-in-devices.md)
- [Admission](../guide/admission.md)

## Users and account data

- [Custom user model](custom-user-model.md)
- [Custom user table or ID type](../guide/custom-schema.md)
- [Drizzle, Prisma, and plain SQL users](../guide/adapters.md)
- [Custom users adapter](custom-adapter.md)
- [Multi-tenant applications](multi-tenant.md)
- [Account export and deletion](../guide/account-data.md)

## Email and notifications

- [Custom email templates](email-templates.md)
- [Development mail](development-mail.md)

## Operations and quality

- [Testing account flows](testing.md)
- [Audit log](audit-log.md)
- [Guided setup](../guide/setup.md)
- [Operations](../guide/operations.md)

## HTTP integration choices

- [Application-owned routes](../guide/application-owned-integration.md)
- [Managed JSON routes](../guide/managed-http.md)
- [Managed social routes](../guide/managed-social.md)
- [Application-owned social routes](../reference/social-reference.md)
