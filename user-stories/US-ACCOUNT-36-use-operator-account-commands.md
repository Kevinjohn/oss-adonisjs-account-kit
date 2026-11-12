# US-ACCOUNT-36 — Issue an invitation or reset link from the shell

As an application operator, I want to help a user or bootstrap an account through trusted operator commands so that I can complete recovery without exposing a privileged HTTP capability.

**Status:** Operator
**Access:** Requires shell access and configured invitation/password-reset capability; operator commands bypass actor authorization and throttles.
**Entry:** Run `account-kit:invite <email> [--role] [--scope] [--print]` or `account-kit:reset-link <email> [--print]`.
**Documentation:** [operations.md](../docs/guide/operations.md)
**Source:** [`commands/invite.ts`](../commands/invite.ts)
**Coverage:** [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)

## Acceptance criteria

- **Inputs and result:** recipient email plus command-specific options; `--print` prints bearer link instead of delivery. The host owns any screen, request parsing and presentation unless the entry explicitly names a managed route or command.
- link is delivered, or printed only when explicitly requested.
- Refusal, expiry, stale state or post-commit delivery behavior follows the linked service contract; a committed mutation is not described as rolled back because a follow-up failed.

## User flow

```mermaid
flowchart TD
    U0["Operator invokes command"]
    U1["unavailable capability or invalid target reports error"]
    U0 --> U1
    U2["eligible action commits"]
    U1 --> U2
    U3["link is delivered, or printed only when explicitly requested."]
    U2 --> U3
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
    C0["Invite/ResetLink.run"]
    C1["use shell-trusted operator service"]
    C0 --> C1
    C2["transaction creates/replaces invitation or reset proof"]
    C1 --> C2
    C3["deliver or print based on flag"]
    C2 --> C3
    C4["report committed follow-up faults distinctly."]
    C3 --> C4
```

**Code references:** [implementation](../commands/invite.ts), [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)
