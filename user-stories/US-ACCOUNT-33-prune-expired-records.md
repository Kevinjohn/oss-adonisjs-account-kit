# US-ACCOUNT-33 — Prune expired proof and session records

As an application operator, I want to remove eligible expired rows in bounded batches so that I can control storage growth without deleting accounts or host records.

**Status:** Operator
**Access:** Explicit scheduled invocation; dry-run is available; configured batch limits apply.
**Entry:** Run `account-kit:prune [--dry-run] [--batch-size] [--max-batches]`.
**Documentation:** [operations.md](../docs/guide/operations.md)
**Source:** [`commands/prune.ts`](../commands/prune.ts)
**Coverage:** [`tests/maintenance.spec.ts`](../tests/maintenance.spec.ts)

## Acceptance criteria

- **Inputs and result:** `account-kit:prune` accepts `--dry-run`, `--batch-size` and `--max-batches`; batch values are 1–1000, with defaults of 100. Reported counts cover this run only; `max-batches` is shared across all tables and dry-run batches use the same budget. It reports eligible rows in dry-run or rows actually deleted across expired proof/session tables; it does not delete users or application records.

## User flow

```mermaid
flowchart TD
 A["Operator starts bounded prune run"] --> B{"Is dry-run selected?"}
 B -->|Yes| C["Count eligible expired rows without deleting"]
 B -->|No| D["Recheck expiry and delete eligible rows in batches"]
 C --> E["Print per-table counts"]
 D --> E
 E --> F{"Did run reach batch cap?"}
 F -->|Yes| G["Schedule another bounded run if rows remain"]
 F -->|No| H["Finish maintenance run"]
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["account-kit:prune"] --> B["Capture expiry cutoff and validate batchSize/maxBatches"]
 B --> C["Select bounded row IDs and recheck each expiry at action time"]
 C --> D{"dryRun?"}
 D -->|Yes| E["Count candidates; perform no deletes"]
 D -->|No| F["Delete rows still expired and count actual removals"]
 E --> G["Print per-table counts"]
 F --> G
```

**Code references:** [implementation](../commands/prune.ts), [`tests/maintenance.spec.ts`](../tests/maintenance.spec.ts)
