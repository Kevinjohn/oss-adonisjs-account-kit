# US-ACCOUNT-23 — Prove a recent social action

As a signed-in account holder, I want to provide recent proof before a sensitive social identity change so that I can limit damage from a stolen active session.

**Status:** Current when social authentication is configured
**Access:** Service requires current credential; proof type and verification depend on configured password/provider flow.
**Entry:** Host invokes `socialAuthentication.provePassword` or provider recent-proof flow before link/unlink; host owns prompts and route policy.
**Documentation:** [social-authentication.md](../docs/guide/social-authentication.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [`tests/social_identity_reauth.spec.ts`](../tests/social_identity_reauth.spec.ts)

## Acceptance criteria

- **Inputs and result:** `socialAuthentication.provePassword({ current, password, purpose })` returns a single-use proof for a supported sensitive purpose (`social_link`, `social_unlink`, `password_change`, `email_change`, `account_export` or `account_delete`). A provider reauthentication path uses `begin({ intent: reauth, current, purpose, clientChallenge })` then callback and returns a proof only when the provider verifies fresh authentication.

## User flow

```mermaid
flowchart TD
 A["Account holder begins a sensitive social action"] --> B{"Does this account use a password or a provider-only credential?"}
 B -->|Password| C["Submit password for requested purpose"]
 C --> D{"Password and current credential validate?"}
 D -->|No| E["Do not issue proof"]
 D -->|Yes| F["Receive one-use purpose-bound proof"]
 B -->|Provider-only| G["Complete fresh provider reauthentication for requested purpose"]
 G --> H{"Provider attests fresh authentication?"}
 H -->|No| E
 H -->|Yes| F
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["provePassword or begin(intent reauth)"] --> B["Bind current account, purpose and client challenge"]
 B --> C["Verify password or provider fresh-auth assertion"]
 C --> D{"Fresh proof is valid?"}
 D -->|No| E["Reject without issuing recent proof"]
 D -->|Yes| F["Store one-use proof; return it for matching sensitive operation"]
 F --> G["Link/unlink consumes proof transactionally and rejects reuse/mismatch"]
```

**Code references:** [implementation](../src/social_identity.ts), [`tests/social_identity_reauth.spec.ts`](../tests/social_identity_reauth.spec.ts)
