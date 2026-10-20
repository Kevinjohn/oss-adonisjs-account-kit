import type { HttpContext } from '@adonisjs/core/http'
import { InvalidInputError, InvalidTokenError } from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationValidator,
} from '#validators/account_kit'
import { accountError, proofFailure, proofHeaders } from '#services/http_responses'
import { committedFollowUp } from '#services/committed_failure_diagnostic'

function invitationIdParam(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid invitation ID')
  return id
}

export default class InvitationsController {
  async send(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    if (actor.currentAccessToken && !actor.currentAccessToken.allows('invitations:create')) {
      return accountError(ctx, 403, 'missing_ability', 'This token cannot create invitations.')
    }
    const { email, role } = await ctx.request.validateUsing(invitationValidator)
    const invitation = await committedFollowUp(ctx.logger, 'invitation.send', () =>
      accountKit.invitations.send({ actorId: actor.id, email, role })
    )
    return invitation
      ? ctx.response.created({ id: invitation.id })
      : ctx.response.accepted({ requested: true })
  }

  async list(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { limit, cursor } = await ctx.request.validateUsing(invitationListValidator)
    return ctx.response.ok(await accountKit.invitations.list({ actorId: actor.id, limit, cursor }))
  }

  async inspect(ctx: HttpContext) {
    proofHeaders(ctx)
    const invitation = await accountKit.invitations.inspect({ token: ctx.params.token })
    return invitation
      ? ctx.response.ok(invitation)
      : proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_TOKEN')
  }

  async accept(ctx: HttpContext) {
    proofHeaders(ctx)
    const { password, fullName } = await ctx.request.validateUsing(invitationAcceptValidator)
    try {
      const user = await committedFollowUp(ctx.logger, 'invitation.accept', () =>
        accountKit.invitations.accept({
          token: ctx.params.token,
          password,
          registrationData: { fullName },
        })
      )
      if (!user) return ctx.response.accepted({ accepted: true })
      return ctx.response.created({
        id: user.id,
        email: user.email,
        verified: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
      })
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_TOKEN')
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
