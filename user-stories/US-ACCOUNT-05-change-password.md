# US-ACCOUNT-05 — Change the current password

As a signed-in account holder, I want to replace my password so that I can protect the account and invalidate older sign-ins.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** `actorId` identifies the signed-in user. A password account must prove `currentPassword`; a social-only account may provide a purpose-bound `recentProof`. The host decides which caller may invoke the service.
**Entry:** Host calls `emailPasswordManagement.changePassword`; the optional managed route validates the request and calls the same service.
**Documentation:** [Account operations](../docs/guide/account-operations.md)
**Source:** [`src/change_password.ts`](../src/change_password.ts)
**Coverage:** [`tests/credentials_password_change.spec.ts`](../tests/credentials_password_change.spec.ts)

## Acceptance criteria

- Service input requires `actorId` and `newPassword`; `currentPassword` is required for a password account, while a social-only account uses `recentProof`. `keepCurrent` is optional and identifies the caller's own session handle or token ID to preserve. The new password must be 8–256 characters and satisfy configured password policy.
- A wrong or missing proof, unknown actor, or disallowed new password leaves the existing password unchanged.
- An accepted change stores the new password, clears applicable recovery proofs, advances credential state, ends other credentials according to `keepCurrent`, and runs observers/notification callbacks after commit. The service returns the resulting revision; post-commit failure does not undo the change.

## User flow

```mermaid
flowchart TD
    A["Account holder submits current proof and new password"] --> B{"Proof valid and new password allowed?"}
    B -->|No| C["Show refusal; existing password stays active"]
    C --> A
    B -->|Yes| D["Password changes and other sign-ins end"]
    D --> E["Keep the caller sign-in only when its handle or token ID matches keepCurrent"]
    E --> F["Show completed change after callbacks succeed, or report a follow-up failure while retaining the committed change"]
```

## Code flow

Scope: the service transaction and configured post-commit callbacks. The host owns the screen and caller authorization; the optional managed handler owns request validation and refreshes a session guard from the returned revision.

```mermaid
flowchart TD
    A["emailPasswordManagement.changePassword"] --> B["Check new-password policy and consume identity throttle"]
    B --> C["Transaction locks actor and confirmActor checks password or social proof"]
    C --> D{"Actor proof accepted?"}
    D -->|No| E["Reject before password mutation"]
    D -->|Yes| F["Store password; clear recovery proofs; credentialsChanged applies keepCurrent"]
    F --> G["Commit and capture credential revision"]
    G --> H["Run credential observer, password notice and lifecycle callback"]
    H --> I{"Follow-ups complete?"}
    I -->|Yes| J["Return revision result"]
    I -->|No| K["Remember committed revision on error and rethrow; do not roll back change"]
```

**Code references:** [`changePassword`](../src/change_password.ts), [`confirmActor`](../src/actor_confirmation.ts), [`authentication.credentialsChanged`](../src/authentication.ts), [`managed password handler`](../src/http/handlers_email_password_management.ts), [`password change tests`](../tests/credentials_password_change.spec.ts)
