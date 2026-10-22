# Choose your stack and starting point

For an existing application, keep the working login route and add password reset first. The
[reset-only integration guide](password-reset-existing-app.md) is the shared prerequisite: the
route, user model and guard stay in place, while the login controller must store the credential
revision and revision-check middleware must enforce it. Session stacks also require a server-side
session store. The [annotated API starter diff](password-reset-starter-diff.md) shows the changes
in context. Account Kit supplies account operations; the application supplies request validation,
authorization, notification delivery and browser/proof pages. All executable paths require Node 24
and pnpm; the [compatibility page](../compatibility.md) describes supported databases.

| Your stack      | Add password reset to an existing application                           | Start a new application (secondary path)                                                                                         |
| --------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Inertia React   | [Use the React reset recipe](../recipes/inertia-react.md)               | Run the [React example](../../examples/inertia-react/README.md#run-it) through its complete account journey.                     |
| Inertia Vue     | [Use the Vue reset recipe](../recipes/inertia-vue.md)                   | Run the [Vue example](../../examples/inertia-vue/README.md#requirements-and-run) through its complete account journey.           |
| Hypermedia/Edge | [Use the Edge reset recipe](../recipes/hypermedia-edge.md)              | Run the [Edge example](../../examples/hypermedia/README.md#install-and-run) with native forms, CSRF and development proof links. |
| API             | [Use the API reset recipe](../recipes/password-reset-existing-login.md) | Follow [Build one account API](core-api.md) from the official AdonisJS 7 API starter.                                            |

The current examples use a separately documented contributor archive path. A normal exact-version
published install remains dependent on a matching package release; do not substitute an archive
while describing an install as published. Read the example's actual install prerequisites before
copying its commands. No release publication is part of this guide.

## New applications

Use a runnable example to see routing, forms, guard state, proof pages and recovery working
together. Follow the README in order: install, environment/key, migrations/code generation, start,
then open its stated URL and observe development emails. The [shared acceptance guide](example-acceptance.md)
explains expected outcomes and distinguishes implementation from HTTP, browser and manual evidence.

For the focused API starter tutorial, complete its [prerequisites and setup](core-api.md#1-create-the-app-and-install-account-kit)
before copying controllers. Its one `/api/v1` namespace and opaque `api` guard are intentional.
The broader API fixture also demonstrates optional integrations; they are not prerequisites for
reset or basic account settings.

## Existing applications

Keep your working login, user model, guard and route namespace. Start with one task in the
[recipe index](../recipes/index.md#add-one-capability-to-an-existing-application), apply its exact
prerequisites and middleware order, and exercise the stated protected-route result. A successful
mutation response alone does not establish that older credentials were revoked.

For browser stacks, copy only the selected flow and its documented foundation. Keep labels, field
errors, focus recovery, CSRF and public non-mutating proof inspection in the application. Translate
response presentation for your stack: Inertia form errors, Edge flash/redirects, or JSON status and
error bodies. Application language stays application-owned; optional `@adonisjs/i18n` integration
uses English fallback when the app does not supply translations.

## Choose the right kind of guide

- A **runnable example** demonstrates a complete composition and its account journey.
- A **focused recipe** adds one capability to an already working application.
- A **reference page** defines configuration, service calls, errors or endpoint contracts.
- **Troubleshooting** begins with the example's startup failures and [doctor/operations](../operations.md),
  then follows the specific error; a green doctor result still needs an operational smoke test.

Within an API path choose [application-owned controllers](../application-owned-integration.md)
when you own HTTP behavior, or [managed JSON routes](../managed-http.md) for selected package
endpoints. [Guided setup](../setup.md) can generate integration files for either choice. Browser
examples call services from their own controllers; managed JSON is not a prerequisite for a form.

## Adoption evidence

The recipes carry their own P3 records: [API reset](../recipes/password-reset-existing-login.md#clean-application-check),
[React reset](../recipes/inertia-react.md#clean-application-check),
[Vue reset](../recipes/inertia-vue.md#clean-application-check),
[Hypermedia/Edge reset](../recipes/hypermedia-edge.md#clean-application-check) and
[invitations](../recipes/invitations-existing-app.md#clean-application-check). The browser-stack
records document their session-store and credential-revocation checks. The shared
[evidence contract](example-acceptance.md#updating-the-record) explains what each record can claim.

## Historical manual checks (21 October 2026)

At source revision `2ae97e7f5629369548f155f4d30f2f6cc25e87e5`, a fresh tracked Vue checkout was
installed, configured, migrated and opened in a browser on Node 24.21.0/pnpm 11.23.0. Manual signup
inspection at 1440×900 and 375×812 checked useful-input retention, empty password fields and keyboard
error recovery. At that revision, a disposable API application also added reset alongside its
existing login; its saved token was rejected on the original protected profile after reset, and a
fresh login succeeded. The verified-route recipe separately recorded guest, unverified and verified
outcomes. The selector, navigation, example anchors and transplant anchors were inspected at desktop
and narrow widths, where the comparison table scrolled horizontally. These observations describe
that revision only; the current recipe records above state the database, browser, notification and
delivery limits for their own runs.
