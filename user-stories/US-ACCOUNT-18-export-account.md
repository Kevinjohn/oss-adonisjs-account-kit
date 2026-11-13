# US-ACCOUNT-18 — Export account data

As an account holder, I want to download a JSON export of account data so that I can receive package-held and host-supplied account information.

**Status:** Current when `dataExport` is enabled
**Access:** Recent password/sign-in proof required. The host may supply `exportAccountData`; without it, the export's `application` value is `null`.
**Entry:** Host endpoint calls `accountData.export`; managed export route is optional.
**Documentation:** [account-data.md](../docs/guide/account-data.md)
**Source:** [`src/account_export.ts`](../src/account_export.ts)
**Coverage:** [`tests/account_export.spec.ts`](../tests/account_export.spec.ts)

## Acceptance criteria

- **Inputs and result:** `accountData.export({ actorId, currentPassword? , recentProof? })` returns the version 1 JSON export. Password accounts prove the current password; password-less accounts use purpose-bound `account_export` proof. When supplied, `exportAccountData` contributes application data; otherwise `application` is `null`. The operation also consumes the user throttle budget and, for social-only proof, consumes a one-use proof transactionally; it does not change account fields.

## User flow

```mermaid
flowchart TD
 A["Account holder requests export and proves identity"] --> B{"Does current password or account_export proof pass?"}
 B -->|No| C["Refuse export without returning account data"]
 B -->|Yes| D["Return package-held fields and host export callback data as JSON"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["accountData.export"] --> B["Throttle and transactionally confirm actor for account_export"]
 B --> C{"Proof valid?"}
 C -->|No| D["Abort read with identity refusal"]
 C -->|Yes| E["Read AccountExport fields"]
 E --> F{"Is exportAccountData configured?"}
 F -->|Yes| G["Invoke optional host callback and return its data in versioned JSON"]
 F -->|No| H["Return versioned JSON with application: null"]
 G --> I["Account fields are unchanged; proof and limiter state are consumed"]
 H --> I
```

**Code references:** [implementation](../src/account_export.ts), [`tests/account_export.spec.ts`](../tests/account_export.spec.ts)
