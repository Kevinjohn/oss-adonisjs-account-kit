# Reference

## Actors and boundaries

- **Account holder**: a person registering, authenticating, recovering credentials, changing settings, using invitations, or requesting account data actions. Account Kit does not supply a frontend.
- **Application**: owns user model, route mounting or controllers, validation and response design, signup eligibility, invitation authorization, profile fields, notification delivery, translation policy, account-domain data and authorization callbacks. There is no universal application role built into Account Kit.
- **Application operator**: installs/configures providers, migrations, session/auth/limiter/mail integration, enables optional capabilities, schedules pruning and uses Ace commands. Shell-only operator services are not an HTTP authorization boundary.
- **Social provider**: configured Ally integration (currently Google/GitHub recipes) that returns provider identity to the application flow.

## Public package surface reviewed

The root export map is [`index.ts`](../index.ts). It exposes `AccountKit` and `defineConfig`; configuration/stub setup; public account types and errors; Lucid adapter types and factory; `createAllySocialProvider`; `accountErrorResponse`; `passwordChangeRevision`; translator, prune and maintenance types; mail provision classes and URL/render/readiness helpers; and log/mail notification helpers and types. The optional admission entry point [`src/admission/main.ts`](../src/admission/main.ts) exposes `defineAdmission`, `AccountAdmission`, admission middleware, invitation evidence/deletion cleanup hooks, admission errors, and admission config/decision/record types. The HTTP entry point is documented in [managed HTTP](../docs/guide/managed-http.md); its route registration is opt-in.

## Source map

- Authentication includes current, requireActive, withCurrent, caller-authorized inspectAccountAccess, host-policy changeRestriction, login-method retirementImpact, login and logout in [src/authentication.ts](../src/authentication.ts); target snapshots are implemented in [src/account_access_inspection.ts](../src/account_access_inspection.ts), and the read-only retirement inventory in [src/login_method_retirement.ts](../src/login_method_retirement.ts).
- Core account services and configuration: [`src/account_kit.ts`](../src/account_kit.ts), [`src/config.ts`](../src/config.ts), [`src/types.ts`](../src/types.ts), [`src/errors.ts`](../src/errors.ts).
- Password reset [`src/password_reset.ts`](../src/password_reset.ts), registration/verification [`src/registration.ts`](../src/registration.ts), authentication [`src/authentication.ts`](../src/authentication.ts), password [`src/change_password.ts`](../src/change_password.ts), email/profile [`src/profile_update.ts`](../src/profile_update.ts) and [`src/email_change.ts`](../src/email_change.ts), invitations [`src/invitations.ts`](../src/invitations.ts) and [`src/invitation_management.ts`](../src/invitation_management.ts).
- Optional capabilities: magic link [`src/magic_link.ts`](../src/magic_link.ts), session management [`src/session_management.ts`](../src/session_management.ts), export/deletion [`src/account_export.ts`](../src/account_export.ts) and [`src/account_deletion.ts`](../src/account_deletion.ts), social identity [`src/social_identity.ts`](../src/social_identity.ts) and HTTP callback [`src/http/social.ts`](../src/http/social.ts), admission [`src/admission/`](../src/admission/).
- HTTP integration and route contracts: [`src/http/managed.ts`](../src/http/managed.ts), [`src/http/`](../src/http/), [endpoint reference](../docs/reference/endpoints.md), [OpenAPI generator](../src/http/openapi.ts).
- Operator commands: [`commands/`](../commands/) includes setup, doctor, retirement impact, prune, invite, reset-link, OpenAPI and admission install. The separately registered admission command loader [`src/admission/commands/main.ts`](../src/admission/commands/main.ts) includes approve, revoke, grant-invitation and bootstrap.
- Adapters and notification integrations: [`adapters/`](../adapters/), [`src/notifications.ts`](../src/notifications.ts), [`src/log_notifications.ts`](../src/log_notifications.ts).
- User documentation: [feature overview](../docs/guide/features.md), [guide index](../docs/README.md), [reference index](../docs/reference/README.md), and examples in [`examples/`](../examples/).

`Current` means source exposes a journey when enabled/configured; it is not a runtime test result. Capabilities such as magic link, session management, account data, social auth, admission, OpenAPI, and managed routes require explicit setup. The catalogue uses the six availability definitions and maintenance rules in the portable [TEMPLATE](TEMPLATE.md).
