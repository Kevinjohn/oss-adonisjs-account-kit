import type { HttpContext } from '@adonisjs/core/http'
import {
  E_ACCOUNT_KIT_INVALID_INPUT,
  E_ACCOUNT_KIT_INVALID_TOKEN,
} from '@kevinjohn/adonisjs-account-kit'
import accountKit from '@kevinjohn/adonisjs-account-kit/services/main'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationValidator,
} from '#validators/account_kit'
import { accountError, proofFailure, proofHeaders } from '#services/http_responses'
import { committedFollowUp } from '#services/committed_failure_diagnostic'

function invitationIdParam(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new E_ACCOUNT_KIT_INVALID_INPUT('Invalid invitation ID')
  return id
}

export default class InvitationsController {
  async send({ auth, request, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    if (actor.currentAccessToken && !actor.currentAccessToken.allows('invitations:create')) {
      return accountError(
        { request, response },
        403,
        'missing_ability',
        'This token cannot create invitations.'
      )
    }
    const { email, role } = await request.validateUsing(invitationValidator)
    const invitation = await committedFollowUp(logger, 'invitation.send', () =>
      accountKit.invitations.send({ actorId: actor.id, email, role })
    )
    return invitation
      ? response.created({ id: invitation.id })
      : response.accepted({ requested: true })
  }

  async list({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { limit, cursor } = await request.validateUsing(invitationListValidator)
    return response.ok(await accountKit.invitations.list({ actorId: actor.id, limit, cursor }))
  }

  async inspect({ response, params, request }: HttpContext) {
    proofHeaders({ response })
    const invitation = await accountKit.invitations.inspect({ token: params.token })
    return invitation
      ? response.ok(invitation)
      : proofFailure({ request, response }, 'E_ACCOUNT_KIT_INVALID_TOKEN')
  }

  async accept({ response, request, logger, params }: HttpContext) {
    proofHeaders({ response })
    const { password, fullName } = await request.validateUsing(invitationAcceptValidator)
    try {
      const user = await committedFollowUp(logger, 'invitation.accept', () =>
        accountKit.invitations.accept({
          token: params.token,
          password,
          registrationData: { fullName },
        })
      )
      if (!user) return response.accepted({ accepted: true })
      return response.created({
        id: user.id,
        email: user.email,
        verified: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
      })
    } catch (error) {
      if (error instanceof E_ACCOUNT_KIT_INVALID_TOKEN) {
        return proofFailure({ request, response }, 'E_ACCOUNT_KIT_INVALID_TOKEN')
      }
      throw error
    }
  }

  async resend({ auth, params, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const invitation = await committedFollowUp(logger, 'invitation.resend', () =>
      accountKit.invitations.resend({
        actorId: actor.id,
        invitationId: invitationIdParam(params.id),
      })
    )
    return invitation ? response.ok({ id: invitation.id }) : response.accepted({ requested: true })
  }

  async revoke({ auth, params, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    await committedFollowUp(logger, 'invitation.revoke', () =>
      accountKit.invitations.revoke({
        actorId: actor.id,
        invitationId: invitationIdParam(params.id),
      })
    )
    return response.noContent()
  }
}
