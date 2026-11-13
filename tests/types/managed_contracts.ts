import type { ManagedQuery, ManagedRequestBody } from '../../http/main.js'

/** The invitation contracts accept the `scope` the validators and handlers accept. */
export const invitationSendWithScope: ManagedRequestBody<'account.invitation.send'> = {
  email: 'invitee@example.com',
  role: 'member',
  scope: 'team:1',
}

export const invitationListWithScope: ManagedQuery<'account.invitation.list'> = {
  limit: 10,
  scope: 'team:1',
}
