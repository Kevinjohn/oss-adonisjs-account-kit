import User from '#models/user'
import { signupValidator } from '#validators/user'
import type { HttpContext } from '@adonisjs/core/http'
import {
  DeliveryError,
  PostCommitError,
  RegistrationEmailAlreadyRegisteredError,
} from 'adonisjs-account-kit'
import accountKit from 'adonisjs-account-kit/services/main'
import UserTransformer from '#transformers/user_transformer'
import { accessTokenGuard, sessionGuard } from '#services/account_kit_guards'
import { authStrategy } from '#services/auth_strategy'
import {
  reportCommittedFailure,
  reportCredentialEstablishmentFailure,
} from '#services/committed_failure_diagnostic'
import { rememberLastUsedMethod } from '#services/last_used_method'

export default class NewAccountController {
  async store(ctx: HttpContext) {
    const { request, response, serialize } = ctx
    const { fullName, email, password } = await request.validateUsing(signupValidator)
    try {
      await accountKit.registration.register({ email, password, registrationData: { fullName } })
    } catch (error) {
      if (error instanceof RegistrationEmailAlreadyRegisteredError) {
        return response.unprocessableEntity({
          errors: [{ field: 'email', rule: 'unique', message: 'The email has already been taken' }],
        })
      }
      if (error instanceof DeliveryError || error instanceof PostCommitError) {
        reportCommittedFailure(ctx.logger, error, 'registration.signup')
        return response.accepted({
          accountCreated: true,
          message:
            'Account created. Request a new verification link or reset your password if delivery did not arrive.',
        })
      }
      throw error
    }
    const strategy = authStrategy()
    const input = { email, password, clientKey: request.ip() }
    let result
    try {
      result =
        strategy === 'session'
          ? await accountKit.authentication.login(input, sessionGuard(ctx))
          : await accountKit.authentication.login(input, accessTokenGuard())
    } catch {
      reportCredentialEstablishmentFailure(ctx.logger, 'registration.credential_establish')
      return response.accepted({
        accountCreated: true,
        message:
          'Account created. Request a new verification link or reset your password if you cannot sign in.',
      })
    }
    const user = await User.findOrFail(result.account.id)
    rememberLastUsedMethod(ctx, 'password')
    return serialize({
      user: UserTransformer.transform(user),
      ...(strategy === 'access_tokens'
        ? { token: (result.credential as { value: string }).value }
        : {}),
    })
  }
}
