# US-ACCOUNT-43 — Change an account restriction

As an application administrator, I want to change an account's restriction state through my host policy so that restricted credentials stop working.

**Status:** Current when authentication is configured
**Access:** The host must authorize the administrator before calling this service; Account Kit supplies no universal administrator role.
**Entry:** Authorized host service calls `authentication.changeRestriction({ userId, change })` and uses the supplied transaction for its policy-state mutation.
**Documentation:** [Account security](../docs/guide/authentication.md)
**Source:** [`src/authentication.ts`](../src/authentication.ts)
**Coverage:** [`tests/authentication.spec.ts`](../tests/authentication.spec.ts)

## Acceptance criteria

- Input requires target `userId` and an async database-only `change(user, trx)` callback. The method returns `void`; callback mutation and credential revocation commit together.
- If the target is missing or the transaction/callback fails before commit, neither the restriction change nor credential revision/revocation commits. After commit, existing credentials are invalidated; any later post-commit failure does not undo the committed restriction or revocation.

## User flow

```mermaid
flowchart TD
 A["Host administrator asks to restrict or restore an account"] --> B{"Did host authorize this administrator?"}
 B -->|No| C["Refuse before calling Account Kit"]
 B -->|Yes| D["Change host restriction state under account transaction"]
 D --> E{"Did the transaction commit?"}
 E -->|No| F["Keep old restriction and credentials"]
 E -->|Yes| G["Restriction and credential revocation are committed"]
```

## Code flow

Scope: host policy callback and credential revocation share one locked transaction.

```mermaid
flowchart TD
 A["authentication.changeRestriction({ userId, change })"] --> B["Lock and load target account"]
 B --> C["Run host change(user, trx)"]
 C --> D["credentialsChanged invalidates sessions and tokens"]
 D --> E{"Did a pre-commit operation fail?"}
 E -->|Yes| F["Roll back restriction and revocation; propagate error"]
 E -->|No| G["Commit restriction and revocation"]
 G --> H{"Did a later post-commit hook fail?"}
 H -->|Yes| I["Surface committed follow-up failure; state remains changed"]
 H -->|No| J["Return void"]
```

**Code references:** [`changeRestriction`](../src/authentication.ts), [`credential invalidation`](../src/credential_revision.ts), [`authentication tests`](../tests/authentication.spec.ts)
