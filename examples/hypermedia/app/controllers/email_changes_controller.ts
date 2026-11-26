import kit from '@kevinjohn/adonisjs-account-kit/services/main'
import { errors } from '@kevinjohn/adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { sendTokenPageHeaders } from '#services/token_page_headers'
import { cancelEmailChangeValidator, requestEmailChangeValidator } from '#validators/email_change'

export default class EmailChangesController {
  async edit({ auth, view }: HttpContext) {
    const user = auth.getUserOrFail()
    return view.render('pages/settings/email', {
      email: user.email,
      pendingEmail:
        user.unverifiedEmail && user.unverifiedEmail !== user.email ? user.unverifiedEmail : null,
      canRequestChange: user.unverifiedEmail !== user.email,
    })
  }

  async store({ request, auth, session, response, logger }: HttpContext) {
    const { email, currentPassword } = await request.validateUsing(requestEmailChangeValidator)
    const user = auth.getUserOrFail()
    if (user.unverifiedEmail === user.email) {
      session.flash('error', 'Confirm your current email before requesting another change.')
      return response.redirect().back()
    }
    if (email === user.email) {
      session.flash('error', 'Enter a different address from your current email.')
      session.flashOnly(['email'])
      return response.redirect().back()
    }
    try {
      await kit.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword,
        newEmail: email,
      })
    } catch (error) {
      if (
        error instanceof errors.E_INVALID_CREDENTIALS ||
        error instanceof errors.E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED
      ) {
        session.flash('error', 'Your current password is incorrect. Check it and try again.')
        session.flashOnly(['email'])
        return response.redirect().back()
      }
      if (error instanceof errors.E_ACCOUNT_KIT_EMAIL_ALREADY_REGISTERED) {
        session.flash('error', 'This address cannot be used. Try another address.')
        session.flashOnly(['email'])
        return response.redirect().back()
      }
      if (!isDeliveryFailure(error)) throw error
      logger.error(
        { event: 'email_change_follow_up_failed' },
        'Email change saved but a follow-up failed'
      )
      session.flash(
        'error',
        'The request was saved, but we could not confirm that the email was sent. Check the new address for a link.'
      )
      return response.redirect().back()
    }
    session.flash(
      'success',
      'Check the development server output for a confirmation link. Your current email stays active until you confirm it.'
    )
    return response.redirect().toPath('/settings/email')
  }

  async cancel({ request, auth, session, response }: HttpContext) {
    const { cancelCurrentPassword } = await request.validateUsing(cancelEmailChangeValidator)
    const user = auth.getUserOrFail()
    try {
      await kit.emailPasswordManagement.updateProfile({
        actorId: user.id,
        currentPassword: cancelCurrentPassword,
        email: user.email,
      })
    } catch (error) {
      if (
        !(error instanceof errors.E_INVALID_CREDENTIALS) &&
        !(error instanceof errors.E_ACCOUNT_KIT_IDENTITY_NOT_CONFIRMED)
      )
        throw error
      session.flash('error', 'Your current password is incorrect. Check it and try again.')
      return response.redirect().back()
    }
    session.flash('success', 'The pending email change was canceled.')
    return response.redirect().toPath('/settings/email')
  }

  async confirm({ response, params, view }: HttpContext) {
    sendTokenPageHeaders(response)
    const valid = await kit.emailPasswordManagement.inspectEmailChange({ token: params.token })
    return view.render('pages/auth/confirm_email_change', { token: params.token, valid })
  }

  async complete({ params, session, response, logger }: HttpContext) {
    try {
      await kit.emailPasswordManagement.completeEmailChange({ token: params.token })
    } catch (error) {
      if (error instanceof errors.E_ACCOUNT_KIT_INVALID_TOKEN) {
        session.flash(
          'error',
          'This email link is invalid, already used, or expired. Sign in to request another change.'
        )
        return response.redirect().withQs(false).toRoute('session.create')
      }
      if (!isDeliveryFailure(error)) throw error
      logger.error(
        { event: 'email_change_follow_up_failed' },
        'Email change committed but a follow-up failed'
      )
    }
    session.flash('success', 'Email changed. Sign in with your new address.')
    return response.redirect().withQs(false).toRoute('session.create')
  }
}
