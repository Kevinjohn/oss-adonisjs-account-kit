# US-ACCOUNT-07 — Update configured profile fields

As a signed-in account holder, I want to change profile fields accepted by the host configuration so that I can keep account details current.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Current account; host defines allowed fields, mapping and request authorization.
**Entry:** Host calls `emailPasswordManagement.updateProfile`; optional managed profile route with configured validator/representation.
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts)
**Coverage:** [`tests/credentials_profile.spec.ts`](../tests/credentials_profile.spec.ts)

## Acceptance criteria

- **Inputs and result:** `emailPasswordManagement.updateProfile({ actorId, email?, registrationData?, currentPassword?, recentProof?, keepCurrent? })` returns the account. At least `email` or `registrationData` must be supplied; profile values are untrusted and mapped by configured registration fields. Every update requires current password or social-only recent proof, including a registrationData-only update. Email follows active/inactive/cancellation branches in US-ACCOUNT-06.

## User flow

```mermaid
flowchart TD
 A["Account holder submits configured profile fields"] --> B{"Did caller provide email or registrationData?"}
 B -->|No| C["Reject empty update without writing"]
 B -->|Yes| D{"Are mapped fields and any email proof accepted?"}
 D -->|No| E["Return validation or identity refusal"]
 D -->|Yes| F["Save mapped profile fields; apply email branch described in US-ACCOUNT-06"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["emailPasswordManagement.updateProfile"] --> B["Map untrusted registrationData and validate optional email"]
 B --> C["Throttle and transactionally confirm actor for every update"]
 C --> D{"Configured fields and uniqueness checks pass?"}
 D -->|No| E["Return refusal; do not persist profile update"]
 D -->|Yes| F["Update adapter-supported fields and/or issue email proof"]
 F --> G["Commit profile update"]
 G --> H{"Do required post-commit callbacks succeed?"}
 H -->|Yes| I["Return updated account"]
 H -->|No| J["Surface post-commit failure; committed profile remains updated"]
```

**Code references:** [implementation](../src/profile_update.ts), [`tests/credentials_profile.spec.ts`](../tests/credentials_profile.spec.ts)
