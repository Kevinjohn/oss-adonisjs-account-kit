# US-ACCOUNT-36 — Issue an invitation from the shell

As an application operator, I want to bootstrap an application invitation through trusted operator commands so that I can bootstrap an invitation without exposing a privileged HTTP capability.

**Status:** Operator
**Access:** Requires shell access and configured invitations capability; operator commands bypass actor authorization and throttles.
**Entry:** Run `account-kit:invite <email> --role <role> [--scope <scope>] [--print]`.
**Documentation:** [operations.md](../docs/guide/operations.md)
**Source:** [`commands/invite.ts`](../commands/invite.ts)
**Coverage:** [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)

## Acceptance criteria

- **Inputs and result:** `operator.invite({ email, role, scope?, deliver })` returns an invitation, optional printed URL and optional follow-up fault. `deliver` is `send` or `print`. Shell access is the authority boundary: this operation has no actor callback or public throttle; a printed URL is a bearer secret.

## User flow

```mermaid
flowchart TD
 A["Operator chooses an invitation recipient, role and delivery mode"] --> B{"Is requested capability enabled and target eligible?"}
 B -->|No| C["Report disabled capability or registered recipient; issue no invitation"]
 B -->|Yes| D{"Is delivery send or explicit print?"}
 D -->|Send| E["Deliver link through configured callback"]
 D -->|Print| F["Print bearer URL to trusted terminal"]
 E --> G["Report committed result and any follow-up fault"]
 F --> G
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["account-kit:invite"] --> B["Call operator.invite with email, role, optional scope and deliver"]
 B --> C["Transaction stores a new invitation and token hash"]
 C --> D{"deliver = send or print?"}
 D -->|send| E["Run configured invitation notification callback"]
 D -->|print| F["Return URL for terminal output"]
 E --> G["Write invitation result and any post-commit fault as JSON"]
 F --> G
```

**Code references:** [implementation](../commands/invite.ts), [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)
