# Choose your stack and starting point

Account Kit supplies account operations. Your application supplies its Auth guard and user model,
request validation, authorization, notification delivery, and browser/proof pages. Decide which
stack and starting point you have before installing or copying files. All executable paths require
Node 24 and pnpm; the [compatibility page](../compatibility.md) describes supported databases.

| Your stack      | Start a new application                                                                                                                   | Add to an existing application                                                                                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inertia React   | Run the [React example](../../examples/inertia-react/README.md#run-it), then follow its signup, verification, settings and reset journey. | Use the [React transplant map](../../examples/inertia-react/README.md#transplant-into-an-existing-app): add its shared browser foundation once, then select one flow.                                                       |
| Inertia Vue     | Run the [Vue example](../../examples/inertia-vue/README.md#requirements-and-run) through its complete account journey.                    | Use the [Vue minimum transplant map](../../examples/inertia-vue/README.md#minimum-transplant-map) and select a flow after its shared foundation.                                                                            |
| Hypermedia/Edge | Run the [Edge example](../../examples/hypermedia/README.md#install-and-run) with native forms, CSRF and development proof links.          | Use the [Edge transplant map](../../examples/hypermedia/README.md#transplanting-into-an-existing-edge-app), preserving middleware order and session policy.                                                                 |
| API             | Follow [Build one account API](core-api.md) from the official AdonisJS 7 API starter.                                                     | Keep existing login and add [one focused task](../recipes/index.md#add-one-capability-to-an-existing-application), or use the [API copy maps](../../examples/api/README.md#copy-maps) for selected application-owned flows. |

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

## Checked adoption routes

The new-application route was exercised from a fresh tracked Vue checkout at
`369ac0fbe87ef372895ac5190396adde7d1b5969`: root install, contributor pack, example install,
environment/key, code generation, migrations and browser startup on Node 24.21.0/pnpm 11.23.0.
The [Vue evidence record](../../examples/inertia-vue/README.md#checks-and-evidence) distinguishes
that archive and setup from its full account-journey suite. Manual signup inspection at 1440×900
and 375×812 checked useful-input retention, empty password fields and keyboard error recovery.

The existing-application route was exercised by adding [reset alongside an existing API login](../recipes/password-reset-existing-login.md)
in a disposable app: its saved token was rejected on the original protected profile after reset,
and a fresh login succeeded. The [verified-route recipe](../recipes/verified-email-route.md#verify-all-three-states)
separately records the minimal API starter install and guest/unverified/verified outcomes without
a direct Session dependency or active Session integration. These are selected executable routes,
not proof that every possible application can copy every stack without adaptation.

The rendered selector, navigation and exact example/transplant anchors were inspected at desktop
and narrow widths. The narrow comparison table scrolls horizontally. Repository link, reference,
snippet and cited-test checks and the documentation build complement that inspection; they do not
establish recipient email delivery or a published-package install.
