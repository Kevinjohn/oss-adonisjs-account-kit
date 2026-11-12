# US-ACCOUNT-13 — Sign in with an email link

As an existing account holder, I want to request and complete an opt-in passwordless sign-in link so that I can sign in without entering a password.

**Status:** Current when `magicLinkLogin` is enabled
**Access:** Links are issued only to existing active accounts allowed by sign-in policy. Request uses generic acknowledgement and rate limits; completion must be bound to the requesting browser/app challenge.
**Entry:** Host calls `magicLink.request` and `magicLink.complete`, or explicitly enables managed routes.
**Documentation:** [magic-link.md](../docs/guide/magic-link.md)
**Source:** [`src/magic_link.ts`](../src/magic_link.ts)
**Coverage:** [`tests/magic_link.spec.ts`](../tests/magic_link.spec.ts), [`tests/magic_link_completion.spec.ts`](../tests/magic_link_completion.spec.ts)

## Acceptance criteria

- **Inputs and result:** `magicLink.request({ email, clientKey, clientChallenge })` returns `void`; it issues a link only for an existing active account allowed by sign-in policy. Unknown or denied addresses receive the same generic acknowledgement and do not create accounts. Challenge is a 43-character base64url SHA-256 digest of a verifier kept by the initiating client. `inspect({ token })` is non-consuming; `complete({ token, verifier }, guard)` returns account and credential.

## User flow

```mermaid
flowchart TD
 A["Client creates verifier and submits email plus its challenge"] --> B["Receive generic request acknowledgement"]
 B --> C["Open link in the same browser or app"]
 C --> D{"Does inspection find a live link?"}
 D -->|No| E["Request another link"]
 D -->|Yes| F{"Does verifier match the stored challenge?"}
 F -->|No| G["Refuse; link remains unusable from this client"]
 F -->|Yes| H["Consume once and establish sign-in credential"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["magicLink.request"] --> B["Validate client challenge, throttle and create hashed proof transactionally"]
 B --> C["Commit and deliver provision; acknowledge generically"]
 D["magicLink.inspect"] --> E["Read token expiry/account status without consuming"]
 F["magicLink.complete"] --> G["Transaction consumes token and matches verifier challenge"]
 G --> H{"Email/account remains eligible?"}
 H -->|No| I["Reject without issuing credential"]
 H -->|Yes| J["Guard establishes credential and service returns account/credential"]
```

**Code references:** [implementation](../src/magic_link.ts), [`tests/magic_link.spec.ts`](../tests/magic_link.spec.ts), [`tests/magic_link_completion.spec.ts`](../tests/magic_link_completion.spec.ts)
