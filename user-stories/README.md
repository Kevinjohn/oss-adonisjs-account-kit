# User story catalogue

Source baseline: `2e0583de9db02bd8a9bcb8256c32b01646db7237` (origin/main, 2026-11-12). Scope: public package exports, account and recovery journeys, optional magic-link/session/data/social/admission capabilities, managed HTTP/OpenAPI, setup and operator actions, adapters and notifications. Source reviewed; no runtime journeys were exercised for this catalogue.

## Index

| Story                                                                 | Action                                             | Status                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| [US-ACCOUNT-01](US-ACCOUNT-01-recover-password.md)                    | Request and complete password recovery             | Current                                                                          |
| [US-ACCOUNT-02](US-ACCOUNT-02-create-and-verify-account.md)           | Register an account                                | Current; availability depends on registration config                             |
| [US-ACCOUNT-03](US-ACCOUNT-03-sign-in.md)                             | Sign in with configured credentials                | Current                                                                          |
| [US-ACCOUNT-04](US-ACCOUNT-04-sign-out.md)                            | Sign out the current credential                    | Current                                                                          |
| [US-ACCOUNT-05](US-ACCOUNT-05-change-password.md)                     | Change the current password                        | Current when `emailPasswordManagement` is enabled                                |
| [US-ACCOUNT-06](US-ACCOUNT-06-change-email.md)                        | Change and confirm the account email               | Current when `emailPasswordManagement` is enabled                                |
| [US-ACCOUNT-07](US-ACCOUNT-07-update-profile.md)                      | Update configured profile fields                   | Current when `emailPasswordManagement` is enabled                                |
| [US-ACCOUNT-08](US-ACCOUNT-08-send-invitation.md)                     | Invite a person to the application                 | Current when `invitations` is explicitly enabled                                 |
| [US-ACCOUNT-09](US-ACCOUNT-09-accept-invitation.md)                   | Accept an invitation                               | Current when `invitations` is explicitly enabled                                 |
| [US-ACCOUNT-10](US-ACCOUNT-10-list-invitations.md)                    | Review invitations                                 | Current when `invitations` is explicitly enabled                                 |
| [US-ACCOUNT-11](US-ACCOUNT-11-resend-invitation.md)                   | Resend an invitation                               | Current when `invitations` is explicitly enabled                                 |
| [US-ACCOUNT-12](US-ACCOUNT-12-revoke-invitation.md)                   | Revoke an invitation                               | Current when `invitations` is explicitly enabled                                 |
| [US-ACCOUNT-13](US-ACCOUNT-13-magic-link.md)                          | Sign in with an email link                         | Current when `magicLinkLogin` is enabled                                         |
| [US-ACCOUNT-14](US-ACCOUNT-14-list-signed-in-devices.md)              | Review signed-in devices                           | Current when `authentication.sessions` (requires `sessionManagement`) is enabled |
| [US-ACCOUNT-15](US-ACCOUNT-15-revoke-device.md)                       | Sign out a selected device                         | Current when `authentication.sessions` (requires `sessionManagement`) is enabled |
| [US-ACCOUNT-16](US-ACCOUNT-16-revoke-other-devices.md)                | Sign out other devices                             | Current when `authentication.sessions` (requires `sessionManagement`) is enabled |
| [US-ACCOUNT-17](US-ACCOUNT-17-revoke-all-devices.md)                  | Sign out everywhere                                | Current when `authentication.sessions` (requires `sessionManagement`) is enabled |
| [US-ACCOUNT-18](US-ACCOUNT-18-export-account.md)                      | Export account data                                | Current when `dataExport` is enabled                                             |
| [US-ACCOUNT-19](US-ACCOUNT-19-delete-account.md)                      | Delete an account                                  | Current when `accountDeletion` is enabled                                        |
| [US-ACCOUNT-20](US-ACCOUNT-20-social-sign-in.md)                      | Sign in with a social provider                     | Current for configured Ally provider and enabled `socialAuthentication`          |
| [US-ACCOUNT-21](US-ACCOUNT-21-link-social-identity.md)                | Link a social identity                             | Current when social authentication is configured                                 |
| [US-ACCOUNT-22](US-ACCOUNT-22-unlink-social-identity.md)              | Unlink a social identity                           | Current when social authentication is configured                                 |
| [US-ACCOUNT-23](US-ACCOUNT-23-prove-social-action.md)                 | Prove a recent social action                       | Current when social authentication is configured                                 |
| [US-ACCOUNT-24](US-ACCOUNT-24-request-admission.md)                   | Request application admission                      | Current when admission module is installed and approval requirement enabled      |
| [US-ACCOUNT-25](US-ACCOUNT-25-gate-application-route.md)              | Gate a protected route by admission                | Current when admission is installed and app applies middleware                   |
| [US-ACCOUNT-26](US-ACCOUNT-26-decide-admission.md)                    | Review an admission request                        | Current when approval is enabled                                                 |
| [US-ACCOUNT-27](US-ACCOUNT-27-revoke-admission.md)                    | Revoke a prior admission decision                  | Current when approval is enabled                                                 |
| [US-ACCOUNT-28](US-ACCOUNT-28-install-admission.md)                   | Install the optional admission module              | Operator                                                                         |
| [US-ACCOUNT-29](US-ACCOUNT-29-mount-managed-routes.md)                | Mount selected managed JSON routes                 | Current when the application explicitly calls route registration                 |
| [US-ACCOUNT-30](US-ACCOUNT-30-generate-openapi.md)                    | Generate an OpenAPI document for mounted routes    | Operator                                                                         |
| [US-ACCOUNT-31](US-ACCOUNT-31-configure-account-kit.md)               | Preview and apply Account Kit setup                | Operator                                                                         |
| [US-ACCOUNT-32](US-ACCOUNT-32-diagnose-account-kit.md)                | Diagnose Account Kit configuration                 | Operator                                                                         |
| [US-ACCOUNT-33](US-ACCOUNT-33-prune-expired-records.md)               | Prune expired proof and session records            | Operator                                                                         |
| [US-ACCOUNT-34](US-ACCOUNT-34-choose-user-adapter.md)                 | Integrate an application user model                | Current                                                                          |
| [US-ACCOUNT-35](US-ACCOUNT-35-configure-notifications.md)             | Deliver account notifications                      | Current                                                                          |
| [US-ACCOUNT-36](US-ACCOUNT-36-use-operator-account-commands.md)       | Issue an invitation from the shell                 | Operator                                                                         |
| [US-ACCOUNT-37](US-ACCOUNT-37-resend-verification.md)                 | Resend email verification                          | Current when `emailVerification` is enabled                                      |
| [US-ACCOUNT-38](US-ACCOUNT-38-complete-email-verification.md)         | Confirm an email address                           | Current when `emailVerification` is enabled                                      |
| [US-ACCOUNT-39](US-ACCOUNT-39-current-account.md)                     | Read the current account                           | Current when authentication is configured                                        |
| [US-ACCOUNT-40](US-ACCOUNT-40-require-active-account.md)              | Require an active account                          | Current when authentication is configured                                        |
| [US-ACCOUNT-41](US-ACCOUNT-41-guard-host-write-with-current.md)       | Commit a host write with a tracked current sign-in | Current when authentication is configured                                        |
| [US-ACCOUNT-42](US-ACCOUNT-42-inspect-account-access.md)              | Inspect account access before acting               | Current when authentication is configured                                        |
| [US-ACCOUNT-43](US-ACCOUNT-43-change-account-restriction.md)          | Change an account restriction                      | Current when authentication is configured                                        |
| [US-ACCOUNT-44](US-ACCOUNT-44-check-login-retirement-impact.md)       | Check login-method retirement impact               | Operator                                                                         |
| [US-ACCOUNT-45](US-ACCOUNT-45-list-admission-records.md)              | List admission records                             | Current when the admission approval requirement is enabled                       |
| [US-ACCOUNT-46](US-ACCOUNT-46-bootstrap-first-administrator.md)       | Bootstrap an approved administrator invitation     | Operator                                                                         |
| [US-ACCOUNT-47](US-ACCOUNT-47-cancel-admission-bootstrap.md)          | Cancel a waiting administrator bootstrap           | Operator                                                                         |
| [US-ACCOUNT-48](US-ACCOUNT-48-grant-admission-invitation-evidence.md) | Grant invitation evidence to an existing account   | Operator                                                                         |
| [US-ACCOUNT-49](US-ACCOUNT-49-approve-admission-as-operator.md)       | Approve an account as an operator                  | Operator                                                                         |
| [US-ACCOUNT-50](US-ACCOUNT-50-revoke-admission-as-operator.md)        | Revoke admission as an operator                    | Operator                                                                         |
| [US-ACCOUNT-51](US-ACCOUNT-51-configure-admission-hooks.md)           | Connect invitation evidence and deletion cleanup   | Current when admission is installed and host selects the wrappers                |
| [US-ACCOUNT-52](US-ACCOUNT-52-issue-reset-link-as-operator.md)        | Issue a password reset link from the shell         | Operator                                                                         |
| [US-ACCOUNT-53](US-ACCOUNT-53-list-social-identities.md)              | Review linked social identities                    | Current when `socialAuthentication` is enabled                                   |
| [US-ACCOUNT-54](US-ACCOUNT-54-check-custom-adapter-contract.md)       | Check a custom user adapter contract               | Current for adapter integration tests                                            |
| [US-ACCOUNT-55](US-ACCOUNT-55-capture-notifications-in-tests.md)      | Capture account notifications in tests             | Current for application tests                                                    |
| [US-ACCOUNT-56](US-ACCOUNT-56-read-current-admission-status.md)       | Read current admission status                      | Current when the admission module is installed                                   |
| [US-ACCOUNT-57](US-ACCOUNT-57-check-admission-record.md)              | Check a user's admission record                    | Current when the admission module is installed                                   |
| [US-ACCOUNT-58](US-ACCOUNT-58-check-domain-eligibility.md)            | Check admission domain eligibility                 | Current when the admission module is installed                                   |

## Catalogue references

- [Portable template and maintenance rules](TEMPLATE.md)
- [Actors, boundaries and source map](REFERENCE.md)
- [Capability coverage](COVERAGE.md)
- [Retained boundaries and decision gaps](GAPS.md)
