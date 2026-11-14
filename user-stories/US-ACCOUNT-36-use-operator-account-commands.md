# US-ACCOUNT-36 — Issue an invitation from the shell

As an application operator, I want to bootstrap an application invitation through trusted operator commands so that I can bootstrap an invitation without exposing a privileged HTTP capability.

**Status:** Operator
**Access:** Requires shell access and configured invitations capability; operator commands bypass actor authorization and throttles.
**Entry:** Run `account-kit:invite <email> --role <role> [--scope <scope>] [--print]`; `invitations` must be explicitly enabled.
**Documentation:** [operations.md](../docs/guide/operations.md)
**Source:** [`commands/invite.ts`](../commands/invite.ts)
**Coverage:** [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)

## Acceptance criteria

- **Inputs and result:** `operator.invite({ email, role, scope?, deliver })` returns an invitation, optional printed URL and optional follow-up fault. The service API scope is an optional string of 1–255 characters; omitted or `null` means unscoped. At the CLI, omitting `--scope` requests an unscoped invitation. `deliver` is `send` or `print`. Shell access is the authority boundary: this operation has no actor callback or public throttle; a printed URL is a bearer secret. If the address already belongs to an account, `operator.invite` throws `EmailAlreadyRegisteredError` before it stores anything, and the command reports the failure.

## User flow

```mermaid
flowchart TD
 A["Operator chooses an invitation recipient, role and delivery mode"] --> B{"Is invitations enabled?"}
 B -->|No| C["Report disabled capability; issue no invitation"]
 B -->|Yes| D{"Does target already have an account?"}
 D -->|Yes| E["Report registered recipient; issue no invitation"]
 D -->|No| F["Replace pending invitation for same email and scope, invalidating its old link"]
 F --> G{"Is delivery send or explicit print?"}
 G -->|Send| H["Deliver link through configured callback"]
 G -->|Print| I["Print bearer URL to trusted terminal"]
 H --> J["Report committed result and any follow-up fault"]
 I --> J
```

## Code flow

Scope: this is the Account Kit service/command path. Host UI, route policy and external systems remain host-owned unless named.

```mermaid
flowchart TD
 A["account-kit:invite"] --> B["Call operator.invite with email, role, optional scope and deliver"]
 B --> B1{"Address already registered?"}
 B1 -->|Yes| B2["Throw EmailAlreadyRegisteredError before storing; command reports failure"]
 B1 -->|No| C["Transaction replaces any pending invitation for the same email and scope, invalidating its old link, and stores the new token hash"]
 C --> D{"deliver = send or print?"}
 D -->|send| E["Run configured invitation notification callback"]
 D -->|print| F["Return URL for terminal output"]
 E --> G["Write invitation result and any post-commit fault as JSON"]
 F --> G
```

**Code references:** [implementation](../commands/invite.ts), [`operatorInvite`](../src/operator.ts), [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)
