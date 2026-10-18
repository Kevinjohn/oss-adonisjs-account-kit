# Audit log

`onLifecycleEvent` receives a typed event after each successful account operation commits. Write
them to an audit table:

```ts
// config/account_kit.ts
import db from '@adonisjs/lucid/services/db'

onLifecycleEvent: async (event) => {
  await db.table('audit_events').insert({
    type: event.type,
    user_id: 'userId' in event ? event.userId : null,
    invitation_id: 'invitationId' in event ? event.invitationId : null,
    operation_id: event.operationId,
    created_at: new Date(),
  })
},
```

The events:

| Type                                                                                                                                                                   | Fields                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `registration.created`, `verification.completed`, `password_reset.requested`, `password.reset`, `password.changed`, `email_change.requested`, `email_change.completed` | `userId`, `operationId`                 |
| `invitation.sent`, `invitation.resent`, `invitation.revoked`                                                                                                           | `invitationId`, `operationId`           |
| `invitation.accepted`                                                                                                                                                  | `invitationId`, `userId`, `operationId` |

Events carry IDs only, never email addresses, tokens or passwords.

## Delivery

The hook runs after commit. If it throws, the operation reports `PostCommitError` with
`committed: true`, and the account change stands. For an audit trail that must never miss an
entry, write inside the transaction instead:

```ts
onCredentialsChangedTransaction: async (user, context, trx) => {
  await trx.table('audit_events').insert({
    type: context.operation,
    user_id: user.id,
    operation_id: context.operationId,
    created_at: new Date(),
  })
},
```

`onCredentialsChangedTransaction` covers credential changes (`password_reset`, `password_change`,
`email_change`, `access_restriction`, `registration_claim`, `social_unlink`).
`onPasswordResetIssuedTransaction` and `onInvitationAccepted` also receive the transaction.

## Further reading

- [Usage: transactions and callbacks](../usage.md#transactions-and-callbacks)
