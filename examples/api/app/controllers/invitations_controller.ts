import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import {
  AccountKit,
  DeliveryError,
  InvalidInputError,
  InvalidTokenError,
  PostCommitError,
} from 'adonisjs-account-kit'
import {
  invitationAcceptValidator,
  invitationListValidator,
  invitationValidator,
} from '#validators/account_kit'
import { accountError, proofFailure, proofHeaders } from '#services/http_responses'
import { reportCommittedFailure } from '#services/committed_failure_diagnostic'

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
    const kit = await app.container.make(AccountKit)
    try {
      const invitation = await kit.invitations.send({ actorId: actor.id, email, role })
      return ctx.response.created({ id: invitation.id })
    } catch (error) {
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(ctx.logger, error, 'invitation.send')
        return ctx.response.accepted({ requested: true })
      }
      throw error
    }
  }

  async list(ctx: HttpContext) {
    const actor = await ctx.auth.getUserOrFail()
    const { limit, cursor } = await ctx.request.validateUsing(invitationListValidator)
    const kit = await app.container.make(AccountKit)
    return ctx.response.ok(await kit.invitations.list({ actorId: actor.id, limit, cursor }))
  }

  async inspect(ctx: HttpContext) {
    proofHeaders(ctx)
    const kit = await app.container.make(AccountKit)
    const invitation = await kit.invitations.inspect({ token: ctx.params.token })
    return invitation
      ? ctx.response.ok(invitation)
      : proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_TOKEN')
  }

  async accept(ctx: HttpContext) {
    proofHeaders(ctx)
    const { password, fullName } = await ctx.request.validateUsing(invitationAcceptValidator)
    const kit = await app.container.make(AccountKit)
    try {
      const user = await kit.invitations.accept({
        token: ctx.params.token,
        password,
        registrationData: { fullName },
      })
      return ctx.response.created({
        id: user.id,
        email: user.email,
        verified: user.unverifiedEmail === null || user.unverifiedEmail !== user.email,
      })
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        return proofFailure(ctx, 'E_ACCOUNT_KIT_INVALID_TOKEN')
      }
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(ctx.logger, error, 'invitation.accept')
        return ctx.response.accepted({ accepted: true })
      }
      throw error
    }
  }

  async resend({ auth, params, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const kit = await app.container.make(AccountKit)
    try {
      const invitation = await kit.invitations.resend({
        actorId: actor.id,
        invitationId: invitationIdParam(params.id),
      })
      return response.ok({ id: invitation.id })
    } catch (error) {
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(logger, error, 'invitation.resend')
        return response.accepted({ requested: true })
      }
      throw error
    }
  }

  async revoke({ auth, params, response, logger }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const kit = await app.container.make(AccountKit)
    try {
      await kit.invitations.revoke({
        actorId: actor.id,
        invitationId: invitationIdParam(params.id),
      })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
      reportCommittedFailure(logger, error, 'invitation.revoke')
    }
    return response.noContent()
  }
}
