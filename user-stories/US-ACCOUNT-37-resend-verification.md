# US-ACCOUNT-37 — Resend email verification

As an account holder with an unconfirmed address, I want to request another verification link so that I can activate my account.

**Status:** Current when `emailVerification` is enabled
**Access:** The host supplies a userId from its authorized request context; Account Kit rate-limits per user.
**Entry:** Host calls `emailVerification.send({ userId })`; optional managed resend endpoint is explicitly enabled.
**Documentation:** [Registration](../docs/guide/registration.md)
**Source:** [`src/verification.ts`](../src/verification.ts)
**Coverage:** [`tests/verification.spec.ts`](../tests/verification.spec.ts)

## Acceptance criteria

- Required input is the account `userId`; result is `sent` or `already_verified`. A repeated request during the one-minute cooldown reuses the active link and does not send another message.
- An already-confirmed account returns `already_verified`; an eligible unconfirmed account receives an activation provision after issuance commits.

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
 A["emailVerification.send({ userId })"] --> B["Throttle and transactionally inspect account/activation proof"]
 B --> C{"Already verified or recent issue?"}
 C -->|Verified| D["Return already_verified"]
 C -->|Recent| E["Reuse link state; do not send another message"]
 C -->|Needs issuance| F["Store hashed activation token"]
 F --> G["Commit and send accountActivationProvision; return sent"]
```

**Code references:** [`sendVerification`](../src/verification.ts), [`verification tests`](../tests/verification.spec.ts)
