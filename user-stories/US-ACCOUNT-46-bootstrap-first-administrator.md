# US-ACCOUNT-46 — Bootstrap an approved administrator invitation

As an application operator, I want to invite an administrator and prepare its approval together so that the first account can be approved without an existing approver.

**Status:** Operator
**Access:** Shell access and explicitly enabled `invitations` and admission approval capabilities; host must configure `withInvitationEvidence` from [US-ACCOUNT-51](US-ACCOUNT-51-configure-admission-hooks.md) for acceptance to attach invitation evidence and claim the waiting approval. Command issues a printed bearer link.
**Entry:** Run `account-kit:admission:bootstrap <email> --role <role>`; the role is required and accepts 1–64 characters as supplied, including whitespace.
**Documentation:** [Admission bootstrap](../docs/guide/admission.md#first-administrator)
**Source:** [`src/admission/bootstrap.ts`](../src/admission/bootstrap.ts)
**Coverage:** [`tests/admission_bootstrap_command.spec.ts`](../tests/admission_bootstrap_command.spec.ts), [`tests/admission_bootstrap.spec.ts`](../tests/admission_bootstrap.spec.ts)

## Acceptance criteria

- The command requires a valid unused email and role of 1–64 characters. It checks for an existing account before URL preparation and again after reserving the invitation key. A successful transaction replaces the same-address unscoped link and its waiting approval together, leaving other invitation scopes intact. A transaction failure preserves the previous pair.
- After commit it attempts the operator `invitation.sent` lifecycle observer, then checks that the exact approval is still waiting. If replacement or cancellation removes that approval, the command reports a failure without exposing a link. If the approval still waits, stdout returns `result: 'printed'`, invitation ID, email, role, expiry, approval and URL. A committed follow-up fault also appears in the result and exits with code 1.
- The waiting approval is bound to this invitation ID. [US-ACCOUNT-51](US-ACCOUNT-51-configure-admission-hooks.md) describes how the configured acceptance wrapper claims it. Other enabled admission requirements still apply and role assignment stays with the host.
- A thrown runtime error stays on Ace's `command.error`, exits nonzero and produces one safe diagnostic on stderr.

## User flow

```mermaid
flowchart TD
 A["Operator enters an unused email and role"] --> B{"Are capabilities and inputs valid, and can both writes commit?"}
 B -->|No| F["Print one safe diagnostic; retain the previous pair"]
 B -->|Yes| G["Save the replacement link and waiting approval together; attempt lifecycle observer"]
 G --> H{"Does the exact approval still wait?"}
 H -->|No| I["Print one safe diagnostic without a link"]
 H -->|Yes| J["Print the link, including any committed follow-up fault"]
 J --> K["Recipient can use the link and the configured hook can claim its waiting approval"]
```

## Code flow

Scope: admission operator service binds the approval inside the shell-trusted invitation transaction, serialised by the unique invitation address and scope.

```mermaid
flowchart TD
 A["BootstrapAdmission.run with cancel unset resolves AccountAdmission and requires role"] --> B["AccountAdmission.operator.bootstrap calls bootstrapOperatorInvitation"]
 B --> C{"Approval, email, role, invitations and unused-address checks pass?"}
 C -->|No| G["Ace retains error; completed prints one diagnostic without a link"]
 C -->|Yes| D["issueOperatorInvitation prepares token and URL; replaceBootstrapInvitation reserves unscoped key and rechecks account"]
 D --> E["Replace invitation and bind its exact waiting approval in the same transaction"]
 E --> F{"Transaction commits?"}
 F -->|No| G
 F -->|Yes| H["Attempt invitation.sent lifecycle observer and retain any committed fault"]
 H --> I{"Matching invitation approval still pending?"}
 I -->|No| G
 I -->|Yes| K["reportOperatorOutcome prints result and bearer warning"]
 K --> L{"Committed follow-up fault?"}
 L -->|Yes| M["Include fault and report exit code 1 with link already printed"]
 L -->|No| N["Finish with successful printed link"]
```

**Code references:** [`bootstrapOperatorInvitation`](../src/admission/bootstrap.ts), [`bootstrap command`](../src/admission/commands/bootstrap.ts), [`operator invitation`](../src/operator.ts), [`bootstrap invitation persistence`](../src/bootstrap_invitation.ts), [command output](../commands/operator_output.ts), [invitation evidence handoff](US-ACCOUNT-51-configure-admission-hooks.md#code-flow), [operator service entry](../src/admission/service.ts)
