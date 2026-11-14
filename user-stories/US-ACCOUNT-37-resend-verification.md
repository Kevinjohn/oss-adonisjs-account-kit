# US-ACCOUNT-37 — Resend email verification

As an account holder with an unconfirmed address, I want to request another verification link so that I can activate my account.

**Status:** Current when `emailVerification` is enabled
**Access:** The host supplies a userId from its authorized request context; Account Kit rate-limits per user.
**Entry:** Host calls `emailVerification.send({ userId })`; optional managed resend endpoint is explicitly enabled.
**Documentation:** [Registration](../docs/guide/registration.md)
**Source:** [`src/verification.ts`](../src/verification.ts)
**Coverage:** [`tests/verification.spec.ts`](../tests/verification.spec.ts)

## Acceptance criteria

- Required input is the account `userId`; an unknown id throws `InvalidInputError`. The result is `sent` or `already_verified`. A repeated request during the one-minute cooldown reuses the active link and does not send another message.
- An already-confirmed account returns `already_verified` without spending the per-user throttle budget; an eligible unconfirmed account receives an activation provision after issuance commits.

## User flow

```mermaid
flowchart TD
 A["Account holder asks host to resend verification"] --> B{"Is account already verified?"}
 B -->|Yes| C["Show already verified outcome"]
 B -->|No| D{"Is resend inside one-minute cooldown?"}
 D -->|Yes| E["Acknowledge without another delivery"]
 D -->|No| F["Issue current activation link and deliver it"]
```

## Code flow

Scope: service issuance and notification; the host owns the authenticated userId selection and response.

```mermaid
flowchart TD
 A["emailVerification.send({ userId })"] --> B{"Account found?"}
 B -->|No| X["Throw InvalidInputError"]
 B -->|Yes| C{"Already verified?"}
 C -->|Yes| D["Return already_verified before any throttle"]
 C -->|No| T["Consume verification:user throttle budget"]
 T --> R{"Recent activation issue?"}
 R -->|Yes| E["Return sent; reuse link state and send no message"]
 R -->|No| F["Transaction locks account and reloads it"]
 F --> F1{"Account missing or verified meanwhile?"}
 F1 -->|Yes| D2["Return already_verified; nothing stored"]
 F1 -->|No| F2{"Recent activation issued meanwhile?"}
 F2 -->|Yes| E2["Return sent; store and send nothing"]
 F2 -->|No| F3["Store hashed activation token"]
 F3 --> G["Commit and send accountActivationProvision; return sent"]
```

**Code references:** [`sendVerification`](../src/verification.ts), [`verification tests`](../tests/verification.spec.ts)
