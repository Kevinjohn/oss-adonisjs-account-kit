import kit from 'adonisjs-account-kit/services/main'
import { errors } from 'adonisjs-account-kit'
import type { HttpContext } from '@adonisjs/core/http'
import { isDeliveryFailure } from '#services/delivery_failure'
import { accountKitSessionGuard } from '#services/session_guard'
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

  async store(ctx: HttpContext) {
    const { email, currentPassword } = await ctx.request.validateUsing(requestEmailChangeValidator)
    const user = ctx.auth.getUserOrFail()
    if (user.unverifiedEmail === user.email) {
      ctx.session.flash('error', 'Confirm your current email before requesting another change.')
      return ctx.response.redirect().back()
    }
    if (email === user.email) {
      ctx.session.flash('error', 'Enter a different address from your current email.')
      ctx.session.flash('old', { email })
      return ctx.response.redirect().back()
    }
    try {
      await kit.emailPasswordManagement.requestEmailChange({
        actorId: user.id,
        currentPassword,
        newEmail: email,
      })
    } catch (error) {
      if (error instanceof errors.InvalidCredentialsError) {
        ctx.session.flash('error', 'Your current password is incorrect. Check it and try again.')
        ctx.session.flash('old', { email })
        return ctx.response.redirect().back()
      }
      if (error instanceof errors.EmailAlreadyRegisteredError) {
        ctx.session.flash('error', 'This address cannot be used. Try another address.')
        return ctx.response.redirect().back()
      }
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'email_change_follow_up_failed' },
        'Email change saved but a follow-up failed'
      )
      ctx.session.flash(
        'error',
        'The request was saved, but we could not confirm that the email was sent. Check the new address for a link.'
      )
      return ctx.response.redirect().back()
    }
    ctx.session.flash(
      'success',
      'Check the development server output for a confirmation link. Your current email stays active until you confirm it.'
    )
    return ctx.response.redirect().toPath('/settings/email')
  }

  async cancel(ctx: HttpContext) {
    const { cancelCurrentPassword } = await ctx.request.validateUsing(cancelEmailChangeValidator)
    const user = ctx.auth.getUserOrFail()
    try {
      await kit.emailPasswordManagement.updateProfile({
        actorId: user.id,
        currentPassword: cancelCurrentPassword,
        email: user.email,
      })
    } catch (error) {
      if (!(error instanceof errors.InvalidCredentialsError)) throw error
      ctx.session.flash('error', 'Your current password is incorrect. Check it and try again.')
      return ctx.response.redirect().back()
    }
    ctx.session.flash('success', 'The pending email change was canceled.')
    return ctx.response.redirect().toPath('/settings/email')
  }

  async confirm(ctx: HttpContext) {
    sendTokenPageHeaders(ctx.response)
    const valid = await kit.emailPasswordManagement.inspectEmailChange({ token: ctx.params.token })
    return ctx.view.render('pages/auth/confirm_email_change', { token: ctx.params.token, valid })
  }

  async complete(ctx: HttpContext) {
    try {
      await kit.emailPasswordManagement.completeEmailChange({ token: ctx.params.token })
    } catch (error) {
      if (error instanceof errors.InvalidTokenError) {
        ctx.session.flash(
          'error',
          'This email link is invalid, already used, or expired. Sign in to request another change.'
        )
        return ctx.response.redirect().toRoute('session.create')
      }
      if (!isDeliveryFailure(error)) throw error
      ctx.logger.error(
        { event: 'email_change_follow_up_failed' },
        'Email change committed but a follow-up failed'
      )
    }
    if (await ctx.auth.use('web').check()) await accountKitSessionGuard(ctx).terminate()
    ctx.session.flash('success', 'Email changed. Sign in with your new address.')
    return ctx.response.redirect().toRoute('session.create')
  }
}
