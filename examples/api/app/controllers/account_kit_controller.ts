/* eslint-disable @unicorn/no-await-expression-member -- Keep the operation and its awaited result adjacent in small controller actions. */

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
  emailChangeValidator,
  invitationValidator,
  passwordValidator,
  invitationAcceptValidator,
  invitationListValidator,
  recoveryRequestValidator,
  credentialChangeValidator,
} from '#validators/account_kit'

const acknowledgement = { message: 'If the account exists, instructions will be sent.' }
const invalidLink = { message: 'This link is invalid or expired.' }

function invitationIdParam(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new InvalidInputError('Invalid invitation ID')
  return id
}

export default class AccountKitController {
  private async kit() {
    return app.container.make(AccountKit)
  }

  async recoveryRequest({ request, response }: HttpContext) {
    const { email } = await request.validateUsing(recoveryRequestValidator)
    try {
      await (await this.kit()).passwordReset.request({ email, clientKey: request.ip() })
    } catch (error) {
      if (!(error instanceof DeliveryError || error instanceof PostCommitError)) throw error
    }
    return response.accepted(acknowledgement)
  }

  async recoveryInspect({ params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    return (await (await this.kit()).passwordReset.inspect({ token: params.token }))
      ? response.ok({ valid: true })
      : response.unprocessableEntity(invalidLink)
  }

  async recoveryReset({ params, request, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const { password } = await request.validateUsing(passwordValidator)
    try {
      await (await this.kit()).passwordReset.reset({ token: params.token, password })
      return response.accepted({ message: 'Password reset.' })
    } catch (error) {
      if (error instanceof InvalidTokenError) return response.unprocessableEntity(invalidLink)
      throw error
    }
  }

  async verificationSend({ auth, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const result = await (await this.kit()).emailVerification.send({ userId: actor.id })
    return response.ok({ result })
  }

  async verificationComplete({ params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    try {
      const result = await (await this.kit()).emailVerification.complete({ token: params.token })
      return response.ok({ result })
    } catch (error) {
      if (error instanceof InvalidTokenError) return response.unprocessableEntity(invalidLink)
      throw error
    }
  }

  async invitationSend({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { email, role } = await request.validateUsing(invitationValidator)
    const invitation = await (
      await this.kit()
    ).invitations.send({
      actorId: actor.id,
      email,
      role,
    })
    return response.created({ id: invitation.id })
  }

  async invitationList({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { limit, cursor } = await request.validateUsing(invitationListValidator)
    const result = await (
      await this.kit()
    ).invitations.list({
      actorId: actor.id,
      limit,
      cursor,
    })
    return response.ok(result)
  }

  async invitationInspect({ params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const invitation = await (await this.kit()).invitations.inspect({ token: params.token })
    return invitation ? response.ok(invitation) : response.unprocessableEntity(invalidLink)
  }

  async invitationAccept({ params, request, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    const { password, fullName } = await request.validateUsing(invitationAcceptValidator)
    try {
      const user = await (
        await this.kit()
      ).invitations.accept({
        token: params.token,
        password,
        registrationData: { fullName },
      })
      return response.created({
        id: user.id,
        email: user.email,
        verified: Boolean(user.emailVerifiedAt),
      })
    } catch (error) {
      if (error instanceof InvalidTokenError) return response.unprocessableEntity(invalidLink)
      throw error
    }
  }

  async invitationResend({ auth, params, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const invitation = await (
      await this.kit()
    ).invitations.resend({
      actorId: actor.id,
      invitationId: invitationIdParam(params.id),
    })
    return response.ok({ id: invitation.id })
  }

  async invitationRevoke({ auth, params, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    await (
      await this.kit()
    ).invitations.revoke({ actorId: actor.id, invitationId: invitationIdParam(params.id) })
    return response.noContent()
  }

  async changePassword({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { currentPassword, newPassword } = await request.validateUsing(credentialChangeValidator)
    await (
      await this.kit()
    ).emailPasswordManagement.changePassword({
      actorId: actor.id,
      currentPassword,
      newPassword,
    })
    return response.ok({ changed: true })
  }

  async requestEmailChange({ auth, request, response }: HttpContext) {
    const actor = await auth.getUserOrFail()
    const { currentPassword, newEmail } = await request.validateUsing(emailChangeValidator)
    await (
      await this.kit()
    ).emailPasswordManagement.requestEmailChange({
      actorId: actor.id,
      currentPassword,
      newEmail,
    })
    return response.accepted({ requested: true })
  }

  async emailChangeInspect({ response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    return response.ok({ confirmation: true })
  }

  async emailChangeComplete({ params, response }: HttpContext) {
    response.header('Referrer-Policy', 'no-referrer')
    try {
      const user = await (
        await this.kit()
      ).emailPasswordManagement.completeEmailChange({ token: params.token })
      return response.ok({ email: user.email, verified: Boolean(user.emailVerifiedAt) })
    } catch (error) {
      if (error instanceof InvalidTokenError) return response.unprocessableEntity(invalidLink)
      throw error
    }
  }
}
