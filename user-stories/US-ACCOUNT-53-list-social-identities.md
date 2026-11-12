# US-ACCOUNT-53 — Review linked social identities

As a signed-in account holder, I want to review my confirmed provider identities so that I can see which accounts can sign in here.

**Status:** Current when `socialAuthentication` is enabled
**Access:** Current credential and revision are checked; only confirmed relationships owned by this account are returned.
**Entry:** Host calls `socialAuthentication.list({ current })` or `get({ current, identityId })`; no built-in identity settings page is provided.
**Documentation:** [Social authentication](../docs/guide/social-authentication.md)
**Source:** [`src/social_identity.ts`](../src/social_identity.ts)
**Coverage:** [`tests/social_identity_services.spec.ts`](../tests/social_identity_services.spec.ts)

## Acceptance criteria

- `list({ current })` takes `CurrentAccountInput` and returns the caller’s confirmed `SocialIdentity[]`; it excludes pending/unconfirmed relationships. `get` also takes numeric `identityId` and returns one confirmed caller-owned identity.
- A stale credential is refused; `get` of an unknown, unconfirmed or foreign identity returns the same not-found outcome. Displayed provider email is relationship metadata and is never an account-merge key.

## User flow

```mermaid
flowchart TD
 A["Signed-in person asks host to list linked providers"] --> B{"Does current credential and revision validate?"}
 B -->|No| C["Return authentication refusal"]
 B -->|Yes| D["Show only confirmed identities linked to this account"]
 D --> E{"Does person request one identity detail?"}
 E -->|No| F["Finish with provider list"]
 E -->|Yes| G{"Is identity confirmed and owned by this account?"}
 G -->|No| H["Return not-found outcome"]
 G -->|Yes| I["Return that provider relationship"]
```

## Code flow

Scope: authenticated service reads; the host owns representation and any page/control.

```mermaid
flowchart TD
 A["socialAuthentication.list({ current })"] --> B["Validate current credential and query confirmed account relationships"]
 B --> C["Return SocialIdentity[]"]
 D["socialAuthentication.get({ current, identityId })"] --> E["Call list for caller and find exact confirmed relationship"]
 E --> F{"Identity present?"}
 F -->|No| G["Throw SocialUserNotFoundError"]
 F -->|Yes| H["Return one SocialIdentity"]
```

**Code references:** [`listSocialIdentities and service list/get`](../src/social_identity.ts), [`social service tests`](../tests/social_identity_services.spec.ts)
