# US-ACCOUNT-44 — Check login-method retirement impact

As an application operator, I want to count accounts affected by a proposed login-method change so that I can avoid removing every usable sign-in path.

**Status:** Operator
**Access:** Requires a booted, configured application and database access; the command is read-only.
**Entry:** Run `account-kit:retirement-impact [--keep-password-login] [--providers <list>] [--quiet [--only-when-retiring]]`.
**Documentation:** [Identity creation](../docs/guide/identity-creation.md)
**Source:** [`commands/retirement_impact.ts`](../commands/retirement_impact.ts)
**Coverage:** [`tests/authentication_retirement.spec.ts`](../tests/authentication_retirement.spec.ts), [`tests/social_retirement.spec.ts`](../tests/social_retirement.spec.ts)

## Acceptance criteria

- The command reports inspected/affected adapter-visible account counts, checkedAt, current providers and current password-login state. `--providers` names unique supported providers remaining; omitted means currently configured providers, `none` means none. With `--quiet --only-when-retiring`, keeping every configured method skips enumeration and returns zero counts. `--keep-password-login` opts into retaining password login; otherwise password login is considered removed. `--quiet` suppresses success and error text while preserving the structured `impact` or `failure` result and nonzero exit status on error.
- An unsupported or repeated `--providers` name exits with code 1, a flag-specific message and the `invalid_providers` failure before the inventory runs. Invalid configuration or unavailable inventory exits nonzero with a generic inventory-unavailable result. The command changes no account or provider state.

## User flow

```mermaid
flowchart TD
 A["Operator specifies proposed remaining password/provider methods; --quiet suppresses printed output"] --> B{"Is proposed provider inventory valid?"}
 B -->|No| C["Return invalid_providers and exit nonzero; print error unless quiet"]
 B -->|Yes| D{"Is the inventory available?"}
 D -->|No| H["Return inventory_unavailable and exit nonzero; print error unless quiet"]
 D -->|Yes| E["Return structured impact; print unless quiet. Counts are zero when the scan is skipped"]
 E --> F["Operator uses result before changing login configuration"]
```

## Code flow

Scope: paginated read-only account inventory; no retirement is performed.

```mermaid
flowchart TD
 A["RetirementImpact.run parses --providers"] --> V{"Valid provider selection?"}
 V -->|No| P["Set invalid_providers and exitCode 1"]
 V -->|Yes| B["Resolve AccountKit and call authentication.retirementImpact"]
 B -->|Resolution or scan fails| U["Set inventory_unavailable and exitCode 1"]
 B --> N{"No current login methods, or quiet retirement-only scan with all methods kept?"}
 N -->|Yes| Z["Return zero counts with current-method snapshot"]
 N -->|No| C["Page adapter-visible users and check passwords and confirmed configured providers"]
 C --> G["Count accounts losing their last method; return counts, snapshot and timestamp"]
```

**Code references:** [`retirement-impact command`](../commands/retirement_impact.ts), [`authentication.retirementImpact`](../src/authentication.ts), [`retirement inventory`](../src/login_method_retirement.ts)
