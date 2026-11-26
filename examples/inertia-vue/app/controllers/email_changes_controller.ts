import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { accountKitSessionGuard } from '#services/session_guard'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { cancelEmailChangeValidator, requestEmailChangeValidator } from '#validators/email_change'

export default class EmailChangesController {
  async edit({ auth, inertia }: HttpContext) {
    const user = auth.getUserOrFail()
    return inertia.render('settings/email', {
      email: user.email,
      pendingEmail:
        user.unverifiedEmail && user.unverifiedEmail !== user.email ? user.unverifiedEmail : null,
      canRequestChange: user.unverifiedEmail !== user.email,
    })
  }

  async store({ auth, request, response, session, logger }: HttpContext) {
    const { email, currentPassword } = await request.validateUsing(requestEmailChangeValidator)
    const user = auth.getUserOrFail()
    if (user.unverifiedEmail === user.email) {
      session.flash('error', 'Confirm your current address before changing it.')
      return response.redirect().back()
    }
    if (email === user.email) {
      session.flash(
        'error',
        'Enter a different address. Use Cancel pending change to keep this one.'
      )
      return response.redirect().back()
    }
    try {
      await kit.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword,
        newEmail: email,
      })
    } catch (error) {
      if (error instanceof errors.E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED) {
        session.flash('error', 'This address cannot be used. Try another address.')
        return response.redirect().back()
      }
      if (!isDeliveryFailure(error)) throw error
      logger.error({ event: 'email_change_follow_up_failed' }, 'email change follow-up failed')
      session.flash(
        'error',
        'The request was saved, but a follow-up did not finish. Check the new address for a link and try again later if none arrives.'
      )
      return response.redirect().back()
    }
    session.flash(
      'success',
      'Check the new address for a confirmation link. Your current address still works until you confirm it.'
    )
    return response.redirect().toRoute('email_changes.edit')
  }

  async cancel({ auth, request, response, session }: HttpContext) {
    const { cancelCurrentPassword } = await request.validateUsing(cancelEmailChangeValidator)
    const user = auth.getUserOrFail()
    await kit.emailPasswordManagement.updateProfile({
      actorId: user.id,
      currentPassword: cancelCurrentPassword,
      email: user.email,
    })
    session.flash('success', 'The pending address change was canceled.')
    return response.redirect().toRoute('email_changes.edit')
  }

  async confirm({ inertia, params, response }: HttpContext) {
    sendTokenPageHeaders(response)
    const valid = await kit.emailPasswordManagement.inspectEmailChange({ token: params.token })
    return inertia.render('auth/confirm_email_change', { token: params.token, valid })
  }

  async complete({ params, session, response, logger, auth }: HttpContext) {
    try {
      await kit.emailPasswordManagement.completeEmailChange({ token: params.token })
    } catch (error) {
      if (error instanceof errors.E_ACCOUNT_KIT_INVALID_TOKEN) {
        session.flash('error', 'This link is invalid, already used, or expired.')
        return response.redirect().withQs(false).toRoute('session.create')
      }
      if (!isDeliveryFailure(error)) throw error
      logger.error({ event: 'email_change_follow_up_failed' }, 'email change follow-up failed')
    }
    if (await auth.use('web').check()) await accountKitSessionGuard({ auth, session }).terminate()
    session.flash('success', 'Email changed. Sign in with your new address.')
    return response.redirect().withQs(false).toRoute('session.create')
  }
}
