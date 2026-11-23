# US-ACCOUNT-37 — Resend email verification

As an account holder with an unconfirmed address, I want to request another verification link so that I can activate my account.

**Status:** Current when `emailVerification` is enabled
**Access:** The host supplies a userId from its authorised request context; Account Kit rate-limits per user.
**Entry:** Host calls `emailVerification.send({ userId })` or mounts `account.emailVerification.send` (POST `account/email-verification/send`, limited access).
**Documentation:** [Registration](../docs/guide/registration.md)
**Source:** [`src/verification.ts`](../src/verification.ts)
**Coverage:** [`tests/verification.spec.ts`](../tests/verification.spec.ts)

## Acceptance criteria

- Required input is the account `userId`; an unknown id throws `InvalidInputError`. The result is `sent` or `already_verified`. A repeated request during the one-minute cooldown reuses the active link and does not send another message.
- An active account returns `already_verified` without spending the per-user throttle budget. An account is active when its pending email differs from its current email, including when the pending email is null. The historical verification timestamp does not determine activation. A pending account outside the cooldown gets an activation provision after issuance commits.
- The managed handler derives `userId` from the authenticated account and returns 200 with `{ result }`. When delivery fails after issuance commits, the service attempts to reopen the cooldown so another request can deliver a fresh link.
- If the managed write recognises a committed follow-up failure, it returns 202 with `{ committed: true }`.

## User flow

```mermaid
flowchart TD
 A["Account holder asks host to resend verification"] --> B{"Is the account active?"}
 B -->|Yes| C["Show already verified outcome"]
 B -->|No| D{"Is resend inside one-minute cooldown?"}
 D -->|Yes| E["Acknowledge without another delivery"]
 D -->|No| F["Issue current activation link and deliver it"]
 F -->|Delivery failure| G["Request another link when eligible"]
```

## Code flow

```mermaid
flowchart TD
 M["Managed route resolves actor; host may supply authorised ID directly"] --> A["emailVerification.send checks emailVerification capability"]
 A --> B{"Account found?"}
 B -->|No| X["Throw InvalidInputError"]
 B -->|Yes| C{"Does pending email differ from current email?"}
 C -->|Yes| D["Return already_verified before any throttle"]
 C -->|No| T["Consume verification:user throttle budget"]
 T --> R{"Recent activation issue?"}
 R -->|Yes| E["Return sent; reuse link state and send no message"]
 R -->|No| F["Transaction locks account and reloads it"]
 F --> F1{"Account missing or pending email now differs from current email?"}
 F1 -->|Yes| D2["Return already_verified; nothing stored"]
 F1 -->|No| F2{"Recent activation issued meanwhile?"}
 F2 -->|Yes| E2["Return sent; store and send nothing"]
 F2 -->|No| F3["Store hashed activation token"]
 F3 --> G["Commit and send accountActivationProvision; return sent or surface delivery failure after attempting to reopen cooldown"]
```

**Code references:** [`sendVerification`](../src/verification.ts), [`verification tests`](../tests/verification.spec.ts), [managed verification send](../src/http/handlers_email_verification.ts), [resend cooldown](../src/token_reuse.ts), [managed committed-failure response](../src/http/managed.ts)
