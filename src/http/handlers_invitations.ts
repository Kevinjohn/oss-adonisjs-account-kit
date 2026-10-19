/** Managed handlers for the invitations capability: public inspect/accept and actor send/list/resend/revoke. */
import { InvalidInputError } from '../errors.js'
import type { ManagedEndpointName } from './routes.js'
import type { ManagedHandler } from './managed_types.js'
import { currentAccount, invalidProof, passwordPolicyError } from './response_helpers.js'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationSendValidator,
} from './validators.js'

function invitationId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid invitation ID')
  return id
}

export const invitationHandlers = {
  'auth.invitation.inspect': async ({ context, kit, options }) => {
    const preview = await kit.invitations.inspect({ token: context.params.token })
    return preview
      ? context.response.ok(preview)
      : invalidProof(context, 'invitation', options.extensions?.message)
  },
  'auth.invitation.accept': async ({ context, kit, options, representIssued }) => {
    const { request, response, params } = context
    const input = options.extensions?.invitationAcceptance
      ? await options.extensions.invitationAcceptance.validate(context)
      : await request.validateUsing(invitationAcceptValidator)
    if (!kit.managedHttp.passwordAllowed(input.password))
      return passwordPolicyError(context, 'password')
    const user = await kit.invitations.accept({
      token: params.token,
      password: input.password,
      registrationData: 'registrationData' in input ? input.registrationData : undefined,
    })
    return response.created({ account: await representIssued(currentAccount(user)) })
  },
  'account.invitation.send': async ({ context, kit, actorId }) => {
    const { email, role } = await context.request.validateUsing(invitationSendValidator)
    const invitation = await kit.invitations.send({ actorId: actorId!, email, role })
    return context.response.created({ id: invitation.id })
  },
  'account.invitation.list': async ({ context, kit, actorId }) => {
    const { limit, cursor } = await context.request.validateUsing(invitationListValidator)
    return context.response.ok(await kit.invitations.list({ actorId: actorId!, limit, cursor }))
  },
  'account.invitation.resend': async ({ context, kit, actorId }) => {
    const invitation = await kit.invitations.resend({
      actorId: actorId!,
      invitationId: invitationId(context.params.id),
    })
    return context.response.ok({ id: invitation.id })
  },
  'account.invitation.revoke': async ({ context, kit, actorId }) => {
    await kit.invitations.revoke({
      actorId: actorId!,
      invitationId: invitationId(context.params.id),
    })
    return context.response.noContent()
  },
} satisfies Partial<Record<ManagedEndpointName, ManagedHandler>>
