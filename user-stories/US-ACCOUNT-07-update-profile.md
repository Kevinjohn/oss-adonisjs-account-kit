# US-ACCOUNT-07 — Update configured profile fields

As a signed-in account holder, I want to change profile fields accepted by the host configuration so that I can keep account details current.

**Status:** Current when `emailPasswordManagement` is enabled
**Access:** Current account; host defines allowed fields, mapping and request authorisation.
**Entry:** Host calls `emailPasswordManagement.updateProfile` or mounts `account.profile.update` (PATCH `account/profile`, limited access).
**Documentation:** [account-operations.md](../docs/guide/account-operations.md)
**Source:** [`src/profile_update.ts`](../src/profile_update.ts)
**Coverage:** [`tests/credentials_profile.spec.ts`](../tests/credentials_profile.spec.ts)

## Acceptance criteria

- **Inputs and result:** `emailPasswordManagement.updateProfile({ actorId, email?, registrationData?, currentPassword?, recentProof?, keepCurrent? })` returns the account. At least `email` or `registrationData` must be supplied; profile values are untrusted and mapped by configured registration fields. Every update requires current password or social-only recent proof, including a registrationData-only update. The proof purpose is `email_change` and the password-less path requires `socialAuthentication`. See [email branches](US-ACCOUNT-06-change-email.md) for updates that include email.
- The managed default validator accepts optional `email`, `registrationData`, `currentPassword` and `recentProof`. A host may replace the validator. Managed success returns 200 with the represented account.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.

## User flow

```mermaid
flowchart TD
 A["Account holder submits configured profile fields"] --> B{"Did caller provide email or registrationData?"}
 B -->|No| C["Reject empty update without writing"]
 B -->|Yes| D{"Are mapped fields and current identity proof accepted?"}
 D -->|No| E["Return validation or identity refusal"]
 D -->|Yes| F["Save mapped profile fields; apply email branch described in US-ACCOUNT-06"]
```

## Code flow

```mermaid
flowchart TD
  M["Managed profile update resolves current account and validates default or host fields"] --> A["emailPasswordManagement.updateProfile"]
  A --> B["Reject empty or invalid email input; map supplied registrationData and throttle actor"]
  B --> C["Transaction confirms actor for email_change"]
  C -->|Refused| E["Abort transaction"]
  C -->|Accepted| D["Write mapped fields if supplied and supported by adapter"]
  D --> G{"Email supplied?"}
  G -->|No| H["Reload account and commit; return updated account without delivery"]
  G -->|Yes| I["Apply the shared email branches in US-ACCOUNT-06 in the same transaction"]
  I --> J["Commit and return account or surface follow-up failure; inactive correction may refresh managed session even on committed error"]
  H --> R["Managed handler returns represented account"]
  J -->|Managed success| R
```

**Code references:** [implementation](../src/profile_update.ts), [`tests/credentials_profile.spec.ts`](../tests/credentials_profile.spec.ts), [managed profile update](../src/http/handlers_email_password_management.ts), [managed committed-failure response](../src/http/managed.ts)
