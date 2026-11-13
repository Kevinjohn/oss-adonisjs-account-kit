# US-ACCOUNT-02 — Register an account

As a prospective account holder, I want to register so that the application creates an account according to its signup policy.

**Status:** Current; availability depends on registration config
**Access:** Signup availability is `open`, `closed`, or `application`; host owns application-mode decision and field mapping.
**Entry:** Host calls `registration.register`; verification is the separate action in [US-ACCOUNT-38](US-ACCOUNT-38-complete-email-verification.md).
**Documentation:** [registration.md](../docs/guide/registration.md)
**Source:** [`src/registration.ts`](../src/registration.ts)
**Coverage:** [`tests/registration.spec.ts`](../tests/registration.spec.ts), [`tests/registration_claim.spec.ts`](../tests/registration_claim.spec.ts)

## Acceptance criteria

- **Inputs and result:** `registration.register({ email, password, registrationData? })` returns the created account when registration is enabled. `registrationData` is untrusted and is passed through configured `registration.mapFields`; availability and password rules come from config.

## User flow

```mermaid
flowchart TD
 A["Prospective account holder submits email, password and configured fields"] --> B{"Is registration availability open or accepted by host application policy?"}
 B -->|No| C["Reject signup without creating an account"]
 B -->|Yes| D["Create inactive account and issue activation link"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["registration.register"] --> B["Check capability, availability, password and mapped fields"]
 B --> C{"Validation and policy pass?"}
 C -->|No| D["Return defined registration error before account creation"]
 C -->|Yes| E["Transaction creates account and activation proof"]
 E --> F["Commit, then deliver activation provision; return account"]
```

**Code references:** [implementation](../src/registration.ts), [`tests/registration.spec.ts`](../tests/registration.spec.ts), [`tests/registration_claim.spec.ts`](../tests/registration_claim.spec.ts)
