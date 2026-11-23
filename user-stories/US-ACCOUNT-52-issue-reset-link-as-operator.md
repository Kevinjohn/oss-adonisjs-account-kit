# US-ACCOUNT-52 — Issue a password reset link from the shell

As an application operator, I want to issue a reset link from the trusted shell so that I can help an account holder recover access without exposing a privileged HTTP operation.

**Status:** Operator
**Access:** Shell access and enabled `passwordReset`; command bypasses actor authorisation and public request throttles.
**Entry:** Run `account-kit:reset-link <email> [--print]`; default sends through configured notification callback, while `--print` outputs the bearer URL instead.
**Documentation:** [Operator commands](../docs/guide/operations.md#operator-commands)
**Source:** [`commands/reset_link.ts`](../commands/reset_link.ts)
**Coverage:** [`tests/operator_commands.spec.ts`](../tests/operator_commands.spec.ts)

## Acceptance criteria

- Input is email and delivery choice `send` or `print`; service returns user, optional URL and optional committed follow-up fault. Unknown email is reported distinctly rather than using the public generic response. A printed URL is a bearer secret.
- The command replaces the user's live reset link. For an unverified account it warns that a completed reset activates the account. It reports committed issuance and exits nonzero if a follow-up fails.
- A thrown runtime error stays on Ace's `command.error`, exits nonzero and produces one safe diagnostic on stderr.

## User flow

```mermaid
flowchart TD
 A["Operator enters account email and chooses delivery"] --> B{"Does account exist and passwordReset capability run?"}
 B -->|No| C["Print one safe diagnostic; issue no reset link"]
 B -->|Yes| D["Replace live reset proof"]
 D --> E{"Send or explicitly print?"}
 E -->|Send| F["Deliver link through configured notification"]
 E -->|Print| G["Print URL only to trusted terminal"]
 F --> H["Report committed result and follow-up fault if present"]
 G --> H
```

## Code flow

Scope: shell-trusted service invocation; never expose this operator API to HTTP.

```mermaid
flowchart TD
 A["account-kit:reset-link"] --> B["operator.resetLink({ email, deliver })"]
 B --> C{"Valid input, matching account and issueResetToken succeeds?"}
 C -->|No| X["Ace retains error; completed prints one diagnostic and exits nonzero"]
 C -->|Yes| D{"deliver is send or print?"}
 D -->|send| E["Run notification callback"]
 D -->|print| F["Skip delivery; include URL in result"]
 E --> H["Run operator-sourced lifecycle follow-up"]
 F --> H
 H --> G["Warn for unverified account; reportOperatorOutcome prints JSON and exits 1 for committed fault"]
```

**Code references:** [`ResetLink command`](../commands/reset_link.ts), [`operatorResetLink`](../src/operator.ts), [`reportOperatorOutcome`](../commands/operator_output.ts), [`operator command tests`](../tests/operator_commands.spec.ts)
