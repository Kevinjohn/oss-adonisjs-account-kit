# US-ACCOUNT-46 — Bootstrap an approved administrator invitation

As an application operator, I want to invite an administrator and prepare its approval together so that the first account can be approved without an existing approver.

**Status:** Operator
**Access:** Shell access and enabled invitation plus admission approval capabilities; command issues a printed bearer link.
**Entry:** Run `account-kit:admission:bootstrap <email> --role <role>`; the role is required and 1–64 characters.
**Documentation:** [Admission bootstrap](../docs/guide/admission.md#first-administrator)
**Source:** [`src/admission/bootstrap.ts`](../src/admission/bootstrap.ts)
**Coverage:** [`tests/admission_bootstrap_command.spec.ts`](../tests/admission_bootstrap_command.spec.ts)

## Acceptance criteria

- Input is email and role; command creates a waiting approval tied to the exact invitation and prints the invitation URL in structured command output. It refuses malformed email, invalid role or an existing account.
- If invitation issuance fails or the waiting approval was replaced, this operation removes only its own waiting row and reports failure; the invitation’s claimed approval is not transferred to a different link.

## User flow

```mermaid
flowchart TD
 A["Operator enters new email and role"] --> B{"Is email valid, unused and role length 1–64?"}
 B -->|No| C["Report validation/registered-account error"]
 B -->|Yes| D["Create waiting approval and issue invitation"]
 D --> E{"Did invitation bind to this approval?"}
 E -->|No| F["Remove this waiting row and report failure"]
 E -->|Yes| G["Print invitation link; accepting account lands approved"]
```

## Code flow

Scope: admission operator service composes an approval row with the shell-trusted invitation service.

```mermaid
flowchart TD
 A["account-kit:admission:bootstrap"] --> B["AccountAdmission.operator.bootstrap({ email, role })"]
 B --> C["Insert unclaimed approval row"]
 C --> D["Call kit.operator.invite with deliver print"]
 D --> E{"Did invitation id attach to this row?"}
 E -->|No| F["Delete only this unclaimed row and throw"]
 E -->|Yes| G["Return invitation result with printed URL"]
```

**Code references:** [`operatorBootstrap`](../src/admission/bootstrap.ts), [`bootstrap command`](../src/admission/commands/bootstrap.ts), [`operator invitation`](../src/operator.ts)
